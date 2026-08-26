'use strict';
import crypto from 'crypto';
import dns from 'dns/promises';
import net from 'net';
import os from 'os';
import { Driver } from 'homey';
import DecoAPIWrapper, {
  AppLogger,
  DecoClient,
  DeviceListResponse,
  LoginAttempt,
} from '../../lib/client';
import { MeshClientCache, MeshClientSnapshot } from '../../lib/mesh-client-cache';
import { describeNetworkReachability } from '../../lib/network-diagnostics';
import { DecoFlowDevice, DeviceFlowRegistration } from '../../lib/flow-registration';
import { MeshTrackedClient, TrackedClient } from '../../lib/client-tracker';
import { SharedAuthenticationCoordinator } from '../../lib/shared-authentication';

// Backoff schedule for the router's "session limit" 403 (RETRY:). The router
// only releases a stale admin session after its own internal timeout, which
// has been observed to exceed the previous flat 3×3s window on some hardware
// (e.g. Homey Pro mini / homey6q reports). Escalating delays give the router
// more time to expire the old session before giving up.
const SESSION_LIMIT_RETRY_BACKOFF_MS = [3000, 5000, 8000, 12000];

// This schedule's delays alone sum to 28s — already over Homey's own ~30s
// hard timeout on the pairing 'login'/'repair' RPC call, before counting any
// actual request time. A user confirmed this in practice: the frontend's
// "Timeout after 30000ms" alert fired mid-pairing while the backend kept
// retrying in the background and went on to succeed anyway — confusing, since
// the dialog implies failure but pairing actually completes. Cap the total
// time spent in the retry loop so it reliably resolves (success or a clear
// friendly error) well before Homey gives up, instead of working past a
// deadline the frontend has already abandoned.
const PAIRING_RETRY_DEADLINE_MS = 20000;

class TplinkDecoDriver extends Driver {
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  private api: DecoAPIWrapper | undefined;

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

  // One shared DecoAPIWrapper per master hostname so all device instances
  // use a single session (the Deco only allows one active session at a time).
  private sharedApis = new Map<string, DecoAPIWrapper>();
  // Serializes authentication and lets later device instances reuse the
  // already-authenticated shared API session.
  private sharedAuthentication = new SharedAuthenticationCoordinator();
  // Tracks hostnames for which network diagnostics have already been logged
  // this session, so re-auth cycles don't flood the log.
  private diagRan = new Set<string>();

  // Per-hostname, per-node-MAC client lists, populated by each device's own
  // regular poll (device_mac: <own MAC>, confirmed working in the field).
  // The previous mesh-wide approach used device_mac: 'default' and consistently
  // returned error_code=1 across ~14 models in our own telemetry — note other
  // TP-Link Deco integrations (e.g. amosyuen/ha-tplink-deco) document 'default'
  // as a supported value, so it may work on some firmware/models and not others,
  // or there's a request-shape difference we're not replicating. Either way,
  // merging confirmed-working per-node data sidesteps the question entirely and
  // costs zero extra API calls.
  private meshClientCache = new MeshClientCache<DecoClient>();
  private deviceFlowRegistration = new DeviceFlowRegistration();

  /**
   * Returns (or lazily creates) the shared API instance for a given hostname.
   * Devices should always call this instead of `new DecoAPIWrapper(...)`.
   */
  public getOrCreateSharedApi(hostname: string): DecoAPIWrapper {
    if (!this.sharedApis.has(hostname)) {
      this.sharedApis.set(hostname, new DecoAPIWrapper(hostname, this.makeLogger()));
    }
    return this.sharedApis.get(hostname)!;
  }

  /**
   * Records the most recent client list a single node reported for itself
   * (device_mac: <own MAC>). Called by every device on each poll cycle.
   */
  public setNodeClientList(hostname: string, nodeMac: string, clients: DecoClient[]): void {
    this.meshClientCache.setNodeClients(hostname, nodeMac, clients);
  }

  /**
   * Merges the most recently reported per-node client lists for a hostname into
   * one mesh-wide list — this is the data the master device needs for
   * join/leave-anywhere-in-the-mesh detection, built from data every node
   * already fetches for itself rather than a dedicated "mesh-wide" API call.
   */
  public getMeshClientSnapshot(
    hostname: string,
    maxAgeMs: number,
  ): MeshClientSnapshot<DecoClient> {
    return this.meshClientCache.getSnapshot(hostname, maxAgeMs);
  }

  /**
   * Authenticates the shared API for a hostname.
   * If an auth is already in progress (from another device instance),
   * returns the same promise so only ONE login hits the router.
   */
  public async sharedAuthenticate(
    hostname: string,
    password: string,
    force = false,
  ): Promise<boolean> {
    const api = this.getOrCreateSharedApi(hostname);
    return this.sharedAuthentication.authenticate(
      hostname,
      () => Boolean(api.stok),
      async () => {
        if (!this.diagRan.has(hostname)) {
          this.diagRan.add(hostname);
          await this.logNetworkDiagnostics(hostname);
        }
        return api.authenticate(password);
      },
      force,
    );
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

    // TCP port 80 reachability
    const tcpOk = await this.checkTcpPort(resolvedIP, 80);
    this.log(`[diag] TCP port 80 → ${resolvedIP}: ${tcpOk ? 'reachable' : 'UNREACHABLE'}`);

    // Also try port 443 in case the Deco uses HTTPS
    const tcpOk443 = await this.checkTcpPort(resolvedIP, 443);
    this.log(`[diag] TCP port 443 → ${resolvedIP}: ${tcpOk443 ? 'reachable' : 'UNREACHABLE'}`);

    const routeDescription = describeNetworkReachability({
      sameSubnet: Boolean(matched),
      httpReachable: tcpOk,
      httpsReachable: tcpOk443,
    });
    if (matched) {
      this.log(`[diag] Network path: ${routeDescription} — Homey ${matched.address}/${matched.netmask}, router ${resolvedIP}`);
      return;
    }

    const homeyList = localIfaces.map((i) => `${i.address}/${i.netmask}`).join(', ');
    this.log(`[diag] Network path: ${routeDescription} — Homey [${homeyList}], router ${resolvedIP}`);
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
      debug: (...args: any[]) => {
        if (this.debugEnabled) this.log(...args);
      },
      error: (...args: any[]) => this.error(...args),
    };
  }

  /**
   * Called when the driver is initialized.
   * Checks if API settings are available; if not, waits for user input.
   */
  async onInit() {
    this.log('TP-Link Deco Driver has been initialized');

    this.deviceFlowRegistration.register(
      this.homey.flow,
      {
        buildClientAutocomplete: (device, query) => this.buildClientAutocomplete(device, query),
        buildMeshClientAutocomplete: (query) => this.buildMeshClientAutocomplete(query),
        getMasterDevice: () => this.getMasterDevice(),
        getTrackedClients: (device) => this.getTrackedClientsForDevice(device),
      },
    );

  }

  /**
   * Finds the paired device representing the mesh's master node, which is the only
   * device that maintains meshTrackedClients. Returns undefined if no master is paired.
   */
  private getMasterDevice(): DecoFlowDevice | undefined {
    return (this.getDevices() as unknown as DecoFlowDevice[]).find(
      (device) => String(device.getSettings().role ?? '').toLowerCase() === 'master',
    );
  }

  /**
   * Builds an autocomplete result list from the master device's mesh-wide client history.
   * Mirrors buildClientAutocomplete, but sourced mesh-wide instead of per-node.
   */
  public buildMeshClientAutocomplete(query: string) {
    const master = this.getMasterDevice();
    const trackedCount = master ? Object.keys(master.meshTrackedClients ?? {}).length : 0;
    this.log(`buildMeshClientAutocomplete: master=${master ? master.getName() : 'NOT FOUND'} trackedClients=${trackedCount}`);
    return this.buildClientAutocompleteFrom(master?.meshTrackedClients ?? {}, query);
  }

  /**
   * Builds an autocomplete result list from a device's tracked client history.
   * Shows all clients seen in the last 30 days (online and offline).
   * Online clients are shown first; offline clients show their last-seen date.
   */
  public buildClientAutocomplete(device: DecoFlowDevice, query: string) {
    return this.buildClientAutocompleteFrom(this.getTrackedClientsForDevice(device), query);
  }

  private getTrackedClientsForDevice(
    device: DecoFlowDevice,
  ): Record<string, TrackedClient | MeshTrackedClient> {
    const isMaster = String(device.getSettings().role ?? '').toLowerCase() === 'master';
    if (isMaster && Object.keys(device.meshTrackedClients).length > 0) {
      return device.meshTrackedClients;
    }
    return device.trackedClients;
  }

  /**
   * Shared filtering/sorting logic behind buildClientAutocomplete and
   * buildMeshClientAutocomplete — only the source tracked-client map differs.
   */
  private buildClientAutocompleteFrom(
    tracked: Record<string, TrackedClient | MeshTrackedClient>,
    query: string,
  ) {
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
    let lastLoginTrace: LoginAttempt[] = [];

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
        lastLoginTrace = [];
        await this.logNetworkDiagnostics(hostname);
        // Use the same shared instance + auth queue as already-paired devices for this
        // hostname (see getOrCreateSharedApi/sharedAuthenticate above). A fresh, isolated
        // DecoAPIWrapper here would compete with sibling mesh nodes' ongoing polling for
        // the router's single admin session slot — and since that polling keeps renewing
        // its own session indefinitely, a competing login would never succeed no matter
        // how long the backoff is. Sharing the instance means there's only ever one login
        // in flight for this hostname, app-wide.
        this.api = this.getOrCreateSharedApi(hostname);

        // The router only allows one active admin session. Re-pairing right after
        // deleting the old devices can hit the previous session before it has timed
        // out on the router side (the app never sends an explicit logout), which
        // surfaces as a 403 → "RETRY:" error. That is not an unrecognised login
        // protocol, so retry with an escalating backoff before giving up — some
        // routers (e.g. reports from Homey Pro mini / homey6q) need longer than a
        // flat few seconds to release the stale session.
        const maxAttempts = SESSION_LIMIT_RETRY_BACKOFF_MS.length + 1;
        const pairingRetryStart = Date.now();
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await this.sharedAuthenticate(hostname, password, true);
            this.log('Successfully connected to TP-Link Deco');
            // Navigate explicitly rather than relying on a declarative
            // navigation.next on this step (see v1.4.51) — but kept OUTSIDE
            // the error-handling logic below: a PairSession.showView() failure
            // (e.g. the pairing UI already moved on) is not an auth error and
            // must never be miscategorised as one. Mis-categorising it here
            // previously fell into the "unknown protocol" branch below, which
            // tried session.showView('login_failed') on the same broken
            // session — an unhandled rejection that crashed the app silently.
            // Login already succeeded at this point, so a navigation hiccup
            // is logged and ignored rather than failing the whole pairing.
            try {
              await session.showView('list_devices');
            } catch (navError: any) {
              this.error('pair: session.showView(list_devices) failed (login already succeeded, ignoring)', navError);
            }
            return true;
          } catch (error: any) {
            const msg: string = error?.message ?? '';
            lastLoginTrace = (error as any)?.loginTrace ?? [];

            if (msg.startsWith('NETWORK:')) {
              this.error('pair: network error:', msg);
              throw new Error(msg.replace('NETWORK: ', ''));
            }
            if (msg.startsWith('CREDENTIALS:')) {
              this.error('pair: credentials error:', msg);
              throw new Error(msg.replace('CREDENTIALS: ', ''));
            }
            if (msg.startsWith('RETRY:')) {
              const delayMs = SESSION_LIMIT_RETRY_BACKOFF_MS[attempt - 1];
              const elapsed = Date.now() - pairingRetryStart;
              if (attempt < maxAttempts && elapsed + delayMs < PAIRING_RETRY_DEADLINE_MS) {
                this.log(`pair: login rejected (router session limit) — retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
              }
              this.error(`pair: login still rejected after retries (or over the ${PAIRING_RETRY_DEADLINE_MS / 1000}s pairing time budget) — a previous session is likely still active on the router:`, msg);
              (this.homey.app as any).reportIssue?.(
                `Pairing: router session limit not released after ${maxAttempts} retries (hostname=${hostname})`,
                { hostname, loginTrace: lastLoginTrace },
              );
              throw new Error('The router rejected the login because another session is already active — most often the TP-Link Deco app or its web admin page logged in on a phone or browser somewhere. Close those and try again. (This can also happen briefly right after deleting and re-adding devices.) If this keeps happening, the TP-Link Deco app supports a separate "Manager" account (App → More → Managers) — use that for everyday phone access and reserve your main owner login for Homey, so the two stop kicking each other out.');
            }
            // Unknown protocol — all formats tried. Navigate to diagnostic view.
            this.error('pair: login failed — all formats exhausted. Navigating to diagnostic view. Trace:', JSON.stringify(lastLoginTrace));
            (this.homey.app as any).reportIssue?.(
              `Pairing: unrecognised login protocol (hostname=${hostname})`,
              { hostname, loginTrace: lastLoginTrace },
            );
            try {
              await session.showView('login_failed');
            } catch (navError: any) {
              this.error('pair: session.showView(login_failed) failed (session likely already gone)', navError);
            }
            return false;
          }
        }
        return false;
      },
    );

    session.setHandler('get_diagnostic', async () => {
      return { trace: lastLoginTrace };
    });

    // Fired when the user fills in model/firmware on the login_failed view and copies
    // the debug report — forwards the same details to remote diagnostics so unsupported firmware
    // is visible even when the user doesn't get around to opening a GitHub issue.
    session.setHandler('report_diagnostic', async (data: { model: string; firmware: string }) => {
      (this.homey.app as any).reportIssue?.(
        `Pairing: unrecognised login protocol — ${data?.model || 'unknown model'} fw ${data?.firmware || 'unknown'} (hostname=${hostname})`,
        { hostname, model: data?.model, firmware: data?.firmware, loginTrace: lastLoginTrace },
      );
      return true;
    });

    session.setHandler('goto_login', async () => {
      await session.showView('login_credentials');
      return true;
    });

    session.setHandler('list_devices', async () => {
      this.log('pair: list_devices');
      if (!this.api) {
        this.error('No API instance available');
        return [];
      }
      const api = this.api;
      try {
        const deviceList = await this.safeApiCall<DeviceListResponse>(
          () =>
            api.custom<DeviceListResponse>(
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
                  previous: '',
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

          const devices = deviceList.result.device_list.map((device) => {
            const nickname = this.cleanString(this.resolveNickname(device));
            const deviceName = device.device_model + (nickname ? ' - ' + nickname : '');
            return {
            name: deviceName,
            data: {
              id: device.mac,
            },
            settings: {
              name: deviceName,
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
          };
          });
          this.log(devices.map((d) => ({ ...d, settings: { ...d.settings, password: '[redacted]' } })));
          if (this.debugEnabled) {
            this.homey.app.log(
              `driver.ts:onInit() driver: `,
              JSON.stringify(devices, null, 2),
            );
          }
          return devices;
        } else {
          this.error('Failed to retrieve device information');
          return [];
        }
      } catch (error) {
        // Must return an array here — the built-in list_devices pairing template
        // reads .length on whatever this handler returns, so an implicit
        // `undefined` return (the previous behaviour) crashes the pairing UI
        // with "cannot read properties of null (reading 'length')" instead of
        // showing an empty list / error.
        this.error('Failed to retrieve device information', error);
        return [];
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

        // See onPair's login handler for why this shares the driver-wide
        // sharedAuthenticate/getOrCreateSharedApi instead of a fresh instance,
        // and for why RETRY: needs its own retry/branch.
        const maxAttempts = SESSION_LIMIT_RETRY_BACKOFF_MS.length + 1;
        const repairRetryStart = Date.now();
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            await this.sharedAuthenticate(hostname, password, true);
            this.log('Successfully connected to TP-Link Deco');
            return { success: true };
          } catch (error: any) {
            const msg: string = error?.message ?? '';
            this.error('pair: repair error:', msg);
            if (msg.startsWith('NETWORK:') || msg.startsWith('CREDENTIALS:')) {
              return { success: false, error: msg.replace(/^(NETWORK|CREDENTIALS): /, '') };
            }
            if (msg.startsWith('RETRY:')) {
              const delayMs = SESSION_LIMIT_RETRY_BACKOFF_MS[attempt - 1];
              const elapsed = Date.now() - repairRetryStart;
              if (attempt < maxAttempts && elapsed + delayMs < PAIRING_RETRY_DEADLINE_MS) {
                this.log(`pair: repair login rejected (router session limit) — retrying in ${delayMs / 1000}s (attempt ${attempt}/${maxAttempts})`);
                await new Promise((resolve) => setTimeout(resolve, delayMs));
                continue;
              }
              return { success: false, error: 'The router rejected the login because another session is already active — most often the TP-Link Deco app or its web admin page logged in on a phone or browser somewhere. Close those and try again. If this keeps happening, the TP-Link Deco app supports a separate "Manager" account (App → More → Managers) — use that for everyday phone access and reserve your main owner login for Homey.' };
            }
            return { success: false, error: 'Connection failed. Check the IP address and password.' };
          }
        }
        return { success: false, error: 'Connection failed. Check the IP address and password.' };
      },
    );
  }

  // Decodes a device nickname that may be base64-encoded or plain text.
  // Strategy: always attempt base64 decode, then validate the result.
  // If the decoded bytes produce invalid UTF-8 (\uFFFD) or control characters,
  // the input was plain text — return it unchanged.
  //
  // The old regex-based approach incorrectly flagged plain ASCII words whose
  // length is a multiple of 4 (e.g. "Zentrale") as base64, producing garbage
  // like "e❓❓❓❓^" when decoded.
  public decodeNickname(raw: string | undefined): string {
    if (!raw) return '';
    try {
      const decoded = Buffer.from(raw, 'base64').toString('utf-8');
      // \uFFFD = UTF-8 replacement char inserted for invalid byte sequences.
      // \x00-\x1F = control chars that would never appear in a real device name.
      if (decoded.length > 0 && !/[\uFFFD\x00-\x1F]/.test(decoded)) {
        return decoded;
      }
    } catch {
      // not valid base64 at all
    }
    return raw;
  }

  // Resolves a human-readable nickname from a device list entry.
  // Newer firmware (e.g. P9) may store the display name in custom_nickname
  // while nickname is empty or contains a generic placeholder.
  public resolveNickname(device: { nickname?: string; custom_nickname?: string }): string {
    return this.decodeNickname(device.nickname) || this.decodeNickname(device.custom_nickname) || '';
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
