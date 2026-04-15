import crypto from 'crypto';
import { Device } from 'homey';
import decoapiwrapper, { AppLogger } from '../../lib/client';
// Type-only import to access the driver's shared-auth methods without a circular dep
type TplinkDecoDriver = import('./driver').TplinkDecoDriver;
import {
  DeviceListResponse,
  PerformanceResponse,
  WANResponse,
  ClientListResponse,
  InternetResponse,
  ErrorResponse,
} from '../../lib/client';

// How long to retain a client in the tracked list without being seen (30 days)
const TRACKED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TrackedClient {
  mac: string;
  name: string;       // decoded (human-readable)
  ip: string;
  type: string;
  online: boolean;    // currently online on this Deco node
  lastSeen: number;   // unix ms — last time seen online
  firstSeen: number;  // unix ms — first time seen
}

/**
 * Class representing a TP-Link Deco Device in Homey.
 * Manages initialization, settings updates, and device-specific actions.
 */
class TplinkDecoDevice extends Device {
  // Indicates if debug mode is enabled
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;

  // Variables to store previous state values
  private savedCpuUsage = 0;
  private savedMemUsage = 0;
  private savedWanipv4State = false;
  private savedWanipv6State = false;

  // Interval ID for periodic updates
  private timeoutSecondsIntervalId: ReturnType<typeof setInterval> | null =
    null;
  private api: decoapiwrapper | any;

  connected = false; // Connection status
  clients: any[] = []; // Currently online clients (raw, for state comparison)

  // Persistent client history — all clients seen in the last 30 days.
  // Keyed by MAC address. Public so driver.ts can use it for autocomplete.
  trackedClients: Record<string, TrackedClient> = {};

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

  // Returns a logger that routes through the Homey SDK so output appears
  // in diagnostics reports as well as the real-time developer tools.
  private makeLogger(): AppLogger {
    return {
      log: (...args: any[]) => this.log(...args),
      error: (...args: any[]) => this.error(...args),
    };
  }

  /**
   * Initializes the TP-Link Deco device.
   * Sets up the API connection using device settings and starts periodic updates.
   */
  async onInit() {
    try {
      // Log device initialization
      this.homey.app.log(
        `Device instance: ${this.getName()} (${this.getData().id})`,
      );
      this.log(`TP-Link Deco Device initialized: ${this.getName()}`);

      // Retrieve device data
      const devicedata = this.getData();

      // Load persistent client history from store
      this.trackedClients = (this.getStoreValue('trackedClients') as Record<string, TrackedClient>) ?? {};

      // Retrieve device settings
      const settings = this.getSettings();
      this.debug(`Settings:`, settings);

      if (this.hasCapability('alarm_wan_ipv6_state')) {
        await this.removeCapability('alarm_wan_ipv6_state');
      }

      // Slave-only capabilities: only meaningful on satellite nodes.
      // Add for slaves, remove for master (avoids showing redundant "–" / "master" values).
      const initIsMaster = (settings.role ?? '').toLowerCase() === 'master';
      for (const cap of ['signal_strength_2g', 'signal_strength_5g', 'backhaul_connection']) {
        if (initIsMaster && this.hasCapability(cap)) {
          await this.removeCapability(cap);
        } else if (!initIsMaster && !this.hasCapability(cap)) {
          await this.addCapability(cap);
        }
      }
      // Master-only capabilities: CPU, RAM, and WAN status are only reported by the
      // master node. Remove from slaves to avoid stale or never-set values in the UI.
      for (const cap of ['measure_cpu_usage', 'measure_mem_usage', 'alarm_wan_ipv4_state', 'wan_ipv4_ipaddr']) {
        if (!initIsMaster && this.hasCapability(cap)) {
          await this.removeCapability(cap);
        }
      }
      if (initIsMaster && !this.hasCapability('wan_ipv4_ipaddr')) {
        await this.addCapability('wan_ipv4_ipaddr');
      }

      // Check if hostname and password are provided
      if (settings.hostname && settings.password) {
        // Use the driver's shared API instance for this hostname.
        // All device instances on the same master share ONE session —
        // the Deco only allows one active login at a time.
        const driver = this.driver as TplinkDecoDriver;
        this.api = driver.getOrCreateSharedApi(settings.hostname, this.makeLogger());

        // Restore the previously-detected content-type preference so the first
        // auth attempt on restart already uses the known-good encoding rather
        // than retrying via auto-detect every time.
        const savedForceJson = (this.getStoreValue('forceJsonContentType') as boolean) ?? false;
        if (savedForceJson) {
          this.api.c.forceJsonContentType = true;
          this.log('Restored content-type preference: application/json (from store)');
        }

        // Authenticate via the shared serialised auth so concurrent device
        // startups don't all hit the router at once.
        this.connected = await driver
          .sharedAuthenticate(settings.hostname, settings.password, this.makeLogger())
          .catch((e: any) => {
            const msg: string = e?.message ?? '';
            if (msg.startsWith('RETRY:')) {
              this.log('Initial auth deferred (router session limit) — will retry on first poll');
            } else {
              this.error('Authentication failed', e);
            }
            return false;
          });

        if (this.connected) {
          // Persist the content-type preference that auth settled on so future
          // restarts skip the auto-detect retry.
          await this.setStoreValue('forceJsonContentType', this.api.c.forceJsonContentType);
          this.log('Successfully connected to TP-Link Deco');
        }

        // Register capability listeners for reboot, CPU usage, and memory usage
        this.registerCapabilityListener('reboot', async (value) => {
          if (Boolean(value)) {
            this.log(`Reboot triggered: ${Boolean(value)}`);
            this.log(`mac: ${devicedata.id}`);
            const rebooted = await this.api
              .reboot(devicedata.id)
              .catch(this.error);
            if (rebooted) {
              await this.setUnavailable(
                this.homey.__('flow.reboot_deco.message'),
              );
              setTimeout(async () => {
                await this.setAvailable();
                await this.setCapabilityValue('reboot', false).catch(
                  this.error,
                );
              }, 60000); // 60 seconds
            } else {
              this.error('Failed to reboot');
            }
          }
        });

        const clientStateFlow = this.homey.flow.getDeviceTriggerCard(
          'client_state_changed',
        );
        clientStateFlow.registerRunListener(async (args, state) => {
          return (
            args.status === state.status && args.client.mac === state.client.mac
          );
        });

        // Stagger first poll across devices to avoid simultaneous auth attempts.
        // The Deco allows only one session at a time — concurrent logins cause
        // HTTP 403 on all-but-one device. A random 0–15 s delay spreads them out.
        const interval = (settings.timeoutSeconds || 30) * 1000;
        const startupDelay = Math.floor(Math.random() * Math.min(interval, 15000));
        this.log(`First poll in ${startupDelay / 1000}s (stagger offset)`);
        setTimeout(async () => {
          await this.updateDeviceMetrics();
          this.setUpdateInterval(interval);
        }, startupDelay);
      } else {
        this.error('Missing API configuration settings');
      }
    } catch (error) {
      this.error('Failed to initialize device', error);
    }
  }

  /**
   * Handles updates to the device settings.
   * Reinitializes the API connection if relevant settings are changed.
   * @param oldSettings - The old settings before the change.
   * @param newSettings - The new settings after the change.
   * @param changedKeys - The keys that were changed.
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: any };
    newSettings: { [key: string]: any };
    changedKeys: string[];
  }): Promise<void> {
    this.log('Device settings updated:', changedKeys);

    // Update debug mode if changed
    if (changedKeys.includes('debugenabled')) {
      this.debugEnabled = newSettings.debugenabled === 'true';
    }

    // Reinitialize API if hostname or password has changed
    if (changedKeys.includes('hostname') || changedKeys.includes('password')) {
      try {
        const driver = this.driver as TplinkDecoDriver;
        this.api = driver.getOrCreateSharedApi(newSettings.hostname, this.makeLogger());
        // Clear stored content-type preference so fresh auto-detection runs with new credentials.
        await this.setStoreValue('forceJsonContentType', false);
        this.api.c.forceJsonContentType = false;
        this.connected = await driver.sharedAuthenticate(newSettings.hostname, newSettings.password, this.makeLogger());
        if (this.connected) {
          await this.setStoreValue('forceJsonContentType', this.api.c.forceJsonContentType);
        }
        this.log('API reinitialized with updated settings');
      } catch (error) {
        this.error('Failed to reinitialize API', error);
      }
    }

    // Update the interval if timeoutSeconds has changed
    if (changedKeys.includes('timeoutSeconds')) {
      const interval = (newSettings.timeoutSeconds || 15) * 1000; // Default to 15 seconds if not set
      this.setUpdateInterval(interval);
      this.log(
        `Update interval changed to ${newSettings.timeoutSeconds} seconds`,
      );
    }
  }

  /**
   * Called when the device is deleted.
   * Ensures that any active intervals are cleared to prevent continued operations.
   */
  async onDeleted(): Promise<void> {
    this.log('TplinkDecoDevice has been deleted');

    // Clear the interval if it's active
    if (this.timeoutSecondsIntervalId) {
      clearInterval(this.timeoutSecondsIntervalId);
      this.log('Cleared interval for device metrics update');
      this.timeoutSecondsIntervalId = null;
    }
  }

  /**
   * Sets up or updates the interval for updating device metrics.
   * @param interval - The interval in milliseconds.
   */
  private setUpdateInterval(interval: number) {
    // Clear any existing interval
    if (this.timeoutSecondsIntervalId) {
      clearInterval(this.timeoutSecondsIntervalId);
      this.timeoutSecondsIntervalId = null;
    }

    // Set up a new interval with a small jitter (0–5 s) to prevent
    // devices that started at the same offset from drifting back in sync.
    this.timeoutSecondsIntervalId = setInterval(
      this.updateDeviceMetrics.bind(this),
      interval + Math.random() * 5000,
    );
    this.log(`Set update interval to ${interval / 1000} seconds`);
  }

  /**
   * Re-authenticates the API session when the STOK has expired.
   * Returns true if re-authentication succeeded.
   */
  private async reAuthenticate(): Promise<boolean> {
    try {
      const settings = this.getSettings();
      this.log('Session expired, re-authenticating...');
      const driver = this.driver as TplinkDecoDriver;
      // Use the shared serialised auth — if another device is already
      // authenticating, we wait for the same result instead of racing.
      this.connected = await driver.sharedAuthenticate(
        settings.hostname,
        settings.password,
        this.makeLogger(),
      );
      if (this.connected) {
        // Persist the content-type preference that worked so restarts skip re-detection.
        await this.setStoreValue('forceJsonContentType', this.api.c.forceJsonContentType);
        this.log('Re-authentication successful');
      } else {
        this.error('Re-authentication failed');
      }
      return this.connected;
    } catch (e) {
      this.error('Re-authentication error', e);
      return false;
    }
  }

  /**
   * Updates device metrics by fetching data from the API and updating capabilities.
   * Handles performance metrics, WAN IP address, internet status, client list, and client state changes.
   */
  private async updateDeviceMetrics() {
    try {
      const settings = this.getSettings();
      const devicedata = this.getData();

      // Retrieve device list from the API
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
      this.debug(`${settings.hostname} onInit():deviceList: `, deviceList);

      // If the API returns an error or device_list is missing (empty stok returns { error_code:0, result:{} }),
      // the session has expired or was never established — re-auth and wait for next poll
      if (deviceList.error_code !== 0 || !deviceList.result?.device_list) {
        await this.reAuthenticate();
        return;
      }

      if (deviceList.result.device_list.length > 0) {
        // Filter the device list to find the current device
        const device = deviceList.result.device_list.find(
          (d) => d.mac === devicedata.id,
        );

        this.debug(`${settings.hostname} onInit():Filtered device: `, device);

        if (device) {
          // Update device settings with retrieved information
          await this.setSettings({
            hardware_ver: device.hardware_ver,
            software_ver: device.software_ver,
            role: device.role,
            ip: device.device_ip,
          });

          await this.updateCapability(
            'alarm_group_state',
            device.group_status.toLowerCase() !== 'connected',
          );
          await this.updateCapability('device_role', settings.role);
          await this.updateCapability('lan_ipv4_ipaddr', device.device_ip || settings.ip || settings.hostname);

          // Signal strength and backhaul are only meaningful on satellite nodes.
          // Dynamically add/remove so they never appear on the master tile.
          const isMaster = device.role.toLowerCase() === 'master';
          for (const cap of ['signal_strength_2g', 'signal_strength_5g', 'backhaul_connection']) {
            if (isMaster && this.hasCapability(cap)) {
              await this.removeCapability(cap);
            } else if (!isMaster && !this.hasCapability(cap)) {
              await this.addCapability(cap);
            }
          }

          if (!isMaster) {
            const signalLabel = (v: string | undefined) => {
              if (v === '1') return 'Weak';
              if (v === '2') return 'Good';
              if (v === '3') return 'Strong';
              return v || '–';
            };
            await this.updateCapability(
              'signal_strength_2g',
              signalLabel(device.signal_level?.band2_4),
            );
            await this.updateCapability(
              'signal_strength_5g',
              signalLabel(device.signal_level?.band5),
            );
            const connectionTypes: string[] | undefined = (device as any).connection_type;
            const backhaulLabel = (types: string[] | undefined) => {
              if (!Array.isArray(types) || types.length === 0) return '–';
              return types
                .map((t) => {
                  if (t === 'wired') return 'Wired';
                  if (t === 'band2_4') return 'WiFi 2.4 GHz';
                  if (t === 'band5') return 'WiFi 5 GHz';
                  if (t === 'band5_2') return 'WiFi 5 GHz (2)';
                  if (t === 'band6') return 'WiFi 6 GHz';
                  return t; // unknown — show raw so nothing is silently dropped
                })
                .join(' + ');
            };
            await this.updateCapability('backhaul_connection', backhaulLabel(connectionTypes));
          }

          // Fetch performance metrics — only available on master node
          let resultCpuUsage = 0;
          let resultMemUsage = 0;
          if (isMaster) {
            const performance = await this.safeApiCall(
              () =>
                this.api.custom(
                  '/admin/network',
                  { form: 'performance' },
                  this.readBody,
                ),
              {
                error_code: 1,
                result: { cpu_usage: 0, mem_usage: 0 },
              },
              'Performance Metrics',
            );
            resultCpuUsage = Math.round(Number(performance?.result?.cpu_usage ?? 0) * 100);
            resultMemUsage = Math.round(Number(performance?.result?.mem_usage ?? 0) * 100);
            await this.updateCapability('measure_cpu_usage', resultCpuUsage);
            await this.updateCapability('measure_mem_usage', resultMemUsage);
          }

          // Fetch WAN IP address
          if (device.role.toLowerCase() === 'master') {
            const wanResponse = await this.safeApiCall(
              () =>
                this.api.custom(
                  '/admin/network',
                  { form: 'wan_ipv4' },
                  this.readBody,
                ),
              {
                error_code: 1,
                result: {
                  lan: {
                    ip_info: {
                      ip: '',
                      mac: '',
                      mask: '',
                    },
                  },
                  wan: {
                    dial_type: '',
                    enable_auto_dns: '',
                    info: {},
                    ip_info: {
                      dns1: '',
                      dns2: '',
                      gateway: '',
                      ip: '',
                      mac: '',
                      mask: '',
                    },
                  },
                },
              },
              'WAN IPv4 Data',
            );

            // Extract WAN IP address
            const wanIpAddress = wanResponse?.result?.wan?.ip_info?.ip ?? '';
            // Update capability with WAN IP address
            await this.updateCapability('wan_ipv4_ipaddr', wanIpAddress);
          }
          // Fetch Internet status — only available on master node
          if (isMaster) {
            const internetResponse = await this.safeApiCall(
              () =>
                this.api.custom(
                  '/admin/network',
                  { form: 'internet' },
                  this.readBody,
                ),
              {
                error_code: 1,
                result: {
                  ipv4: {
                    auto_detect_type: '',
                    connect_type: '',
                    dial_status: '',
                    error_code: 1,
                    inet_status: '',
                  },
                  ipv6: {
                    auto_detect_type: '',
                    connect_type: '',
                    dial_status: '',
                    error_code: 1,
                    inet_status: '',
                  },
                  link_status: '',
                },
              },
              'Internet Status',
            );

            // Only update WAN alarm when we got a real response (not the safeApiCall fallback).
            // If the call failed/timed-out, error_code is 1 (our default) and we leave
            // the capability at its last known value to avoid false "disconnected" alerts.
            if (internetResponse?.error_code === 0) {
              await this.handleWanStateChange(
                'ipv4',
                internetResponse?.result?.ipv4?.inet_status ?? '',
                this.savedWanipv4State ?? false,
                'alarm_wan_ipv4_state',
              );
              if (internetResponse?.result?.ipv6?.error_code === 0) {
                if (!this.hasCapability('alarm_wan_ipv6_state')) {
                  await this.addCapability('alarm_wan_ipv6_state');
                }
                await this.handleWanStateChange(
                  'ipv6',
                  internetResponse?.result?.ipv6?.inet_status ?? '',
                  this.savedWanipv6State ?? false,
                  'alarm_wan_ipv6_state',
                );
              }
            }
          }

          // Fetch client list — use this device's MAC so each node only reports its own clients,
          // preventing duplicate flow triggers when multiple Deco units are paired.
          const request = {
            operation: 'read',
            params: {
              device_mac: devicedata.id,
            },
          };
          const jsonRequest = JSON.stringify(request);
          const clientListResponse = await this.safeApiCall(
            () =>
              this.api.custom(
                '/admin/client',
                { form: 'client_list' },
                Buffer.from(jsonRequest),
              ),
            {
              error_code: 0,
              result: {
                client_list: [
                  {
                    access_host: '',
                    client_mesh: true,
                    client_type: '',
                    connection_type: '',
                    down_speed: 0,
                    enable_priority: false,
                    interface: '',
                    ip: '',
                    mac: '',
                    name: '',
                    online: true,
                    owner_id: '',
                    remain_time: 0,
                    space_id: '',
                    up_speed: 0,
                    wire_type: '',
                  },
                ],
              },
            },
            'Client List',
          );
          // let clientListResponse = (await this.api.clientList().catch((e) => {
          //   this.error('Failed to retrieve client list', e);
          //   this.homey.app.error('Failed to retrieve client list', e);
          //   return {
          //     error_code: 1,
          //     result: {
          //       client_list: [],
          //     },
          //   }; // Return default values in case of error
          // })) as ClientListResponse;

          // Some Deco firmware returns client_list as {} instead of [] when
          // there are no connected clients. Use Array.isArray to handle all
          // non-array shapes (null, undefined, {}, 0, …).
          const rawClientList = clientListResponse?.result?.client_list;
          const clientList = Array.isArray(rawClientList) ? rawClientList : [];
          const clientNames = clientList
            .map((client) => Buffer.from(client.name, 'base64').toString('utf-8'))
            .join(', ');
          await this.setSettings({ clients: clientNames });
          // Update capability with the number of connected clients
          await this.updateCapability('connected_clients', clientList.length);

          // Handle client state changes
          await this.handleClientStateChanges(clientList);

          // Calculate total download and upload speeds
          const { totalDownKiloBytesPerSecond, totalUpKiloBytesPerSecond } =
            clientList.reduce(
              (totals, client) => {
                totals.totalDownKiloBytesPerSecond += client.down_speed ?? 0;
                totals.totalUpKiloBytesPerSecond += client.up_speed ?? 0;
                return totals;
              },
              { totalDownKiloBytesPerSecond: 0, totalUpKiloBytesPerSecond: 0 },
            );

          // Update capabilities with total download and upload speeds
          await this.updateCapability(
            'measure_down_kilo_bytes_per_second',
            totalDownKiloBytesPerSecond,
          );
          await this.updateCapability(
            'measure_up_kilo_bytes_per_second',
            totalUpKiloBytesPerSecond,
          );

          // Trigger flow cards if CPU or memory usage has changed
          await this.triggerUsageFlowCards(
            resultCpuUsage,
            resultMemUsage,
            settings.hostname,
          );
        }
      }
    } catch (error) {
      this.error('Failed to update device metrics', error);
    }
  }

  /**
   * Handles WAN state changes for IPv4 and IPv6.
   * Triggers flow cards if the WAN state has changed.
   * @param ipVersion - 'ipv4' or 'ipv6'.
   * @param inetStatus - The current internet status.
   * @param savedWanState - The previously saved WAN state.
   * @param capabilityName - The capability name to update.
   */
  private async handleWanStateChange(
    ipVersion: 'ipv4' | 'ipv6',
    inetStatus: string,
    savedWanState: boolean,
    capabilityName: string,
  ) {
    try {
      // Determine current WAN status
      const currentWanStatus = inetStatus?.toLowerCase() !== 'online';

      // Check if WAN status has changed
      if (currentWanStatus !== savedWanState) {
        const cardTriggerWanStatus = this.homey.flow.getDeviceTriggerCard(
          'alarm_wan_state_changed',
        );

        // Trigger flow card for WAN state change
        await cardTriggerWanStatus.trigger(this, {
          wan_state: currentWanStatus,
          ip_version: ipVersion,
        });

        // Update saved WAN state
        this[`savedWan${ipVersion}State`] = currentWanStatus;
      }

      // Update capability with current WAN status
      await this.updateCapability(capabilityName, currentWanStatus);
    } catch (err) {
      this.error(
        `Failed to handle WAN ${ipVersion} state change for device: ${
          this.getName() ?? 'Unknown Device'
        }`,
        err,
      );
    }
  }

  /**
   * Triggers flow cards for CPU and memory usage changes.
   * @param resultCpuUsage - The current CPU usage percentage.
   * @param resultMemUsage - The current memory usage percentage.
   * @param hostname - The hostname of the device.
   */
  private async triggerUsageFlowCards(
    resultCpuUsage: number,
    resultMemUsage: number,
    hostname: string,
  ) {
    try {
      // Trigger flow card for CPU usage change
      if (
        typeof resultCpuUsage === 'number' &&
        resultCpuUsage !== this.savedCpuUsage
      ) {
        const cardTriggerCpuUsage =
          this.homey.flow.getTriggerCard('cpu_usage');
        await cardTriggerCpuUsage.trigger({
          cpu_usage: resultCpuUsage,
        });
        // Update saved CPU usage
        this.savedCpuUsage = resultCpuUsage;
      }

      // Trigger flow card for memory usage change
      if (
        typeof resultMemUsage === 'number' &&
        resultMemUsage !== this.savedMemUsage
      ) {
        const cardTriggerMemUsage =
          this.homey.flow.getTriggerCard('mem_usage');
        await cardTriggerMemUsage.trigger({
          mem_usage: resultMemUsage,
        });
        // Update saved memory usage
        this.savedMemUsage = resultMemUsage;
      }
    } catch (err) {
      this.error('Failed to trigger usage flow cards', err);
    }
  }

  /**
   * Handles client state changes by comparing the current client list with the previous one.
   * Triggers flow cards when clients go online or offline.
   * Also maintains the persistent 30-day trackedClients history.
   * @param clientList - The current list of clients (online on this node right now).
   */
  private async handleClientStateChanges(clientList: any[]) {
    try {
      const clientStateFlow = this.homey.flow.getDeviceTriggerCard(
        'client_state_changed',
      );
      const now = Date.now();

      // Maps for quick lookup
      const lastClientsMap = new Map(
        this.clients?.map((client) => [client.mac, client]),
      );
      const currentClientsMap = new Map(
        clientList.map((client) => [client.mac, client]),
      );

      // Clients that have come online
      for (const [mac, client] of currentClientsMap) {
        const decodedName = Buffer.from(client.name, 'base64').toString();
        const tokens = {
          name: decodedName,
          ipaddr: client.ip,
          mac: client.mac,
          type: client.client_type ?? '',
          connection_type: client.connection_type ?? '',
          interface: client.interface ?? '',
          down_speed: client.down_speed ?? 0,
          up_speed: client.up_speed ?? 0,
        };

        // Update persistent history
        this.trackedClients[mac] = {
          mac: client.mac,
          name: decodedName,
          ip: client.ip,
          type: client.client_type ?? '',
          online: true,
          lastSeen: now,
          firstSeen: this.trackedClients[mac]?.firstSeen ?? now,
        };

        if (!lastClientsMap.has(mac)) {
          await clientStateFlow.trigger(this, tokens, {
            status: 'online',
            client: tokens,
          });
        }
      }

      // Clients that have gone offline
      for (const [mac, client] of lastClientsMap) {
        if (!currentClientsMap.has(mac)) {
          const decodedName = Buffer.from(client.name, 'base64').toString();
          const tokens = {
            name: decodedName,
            ipaddr: client.ip,
            mac: client.mac,
            type: client.client_type ?? '',
            connection_type: client.connection_type ?? '',
            interface: client.interface ?? '',
            down_speed: 0,
            up_speed: 0,
          };

          // Mark as offline in persistent history (keep lastSeen from when they were last online)
          if (this.trackedClients[mac]) {
            this.trackedClients[mac].online = false;
          }

          await clientStateFlow.trigger(this, tokens, {
            status: 'offline',
            client: tokens,
          });
        }
      }

      // Prune clients not seen for more than 30 days
      for (const [mac, tracked] of Object.entries(this.trackedClients)) {
        if (!tracked.online && now - tracked.lastSeen > TRACKED_CLIENT_TTL_MS) {
          delete this.trackedClients[mac];
        }
      }

      // Persist updated history
      await this.setStoreValue('trackedClients', this.trackedClients);

      // Update the current online list for the next comparison
      this.clients = clientList;
    } catch (err) {
      this.error('Failed to handle client state changes', err);
    }
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

  /**
   * Updates a device capability with the provided value.
   * @param capability - The name of the capability to update.
   * @param value - The value to set for the capability.
   */
  private async updateCapability(capability: string, value: any) {
    try {
      const currentValue = this.getCapabilityValue(capability);
      if (currentValue !== value) {
        await this.setCapabilityValue(capability, value);
      }
    } catch (err) {
      this.error(`Failed to update capability ${capability}`, err);
    }
  }

  /**
   * Logs debug messages if debug mode is enabled.
   * @param message - The debug message to log.
   * @param data - Optional data to log with the message.
   */
  private debug(message: string, data?: any) {
    if (this.debugEnabled) {
      if (data !== undefined) {
        this.log(`DEBUG: ${message}`, JSON.stringify(data, null, 2));
      } else {
        this.log(`DEBUG: ${message}`);
      }
    }
  }
}

module.exports = TplinkDecoDevice;
