import crypto from 'crypto';
import { Device } from 'homey';
import decoapiwrapper, { AppLogger } from '../../lib/client';
import { buildWanFlowEvents } from '../../lib/wan-flow-events';
import { resolveWanDisconnected } from '../../lib/wan-status';
// Type-only import to access the driver's shared-auth methods without a circular dep
type TplinkDecoDriver = import('./driver').TplinkDecoDriver;
import {
  DeviceListResponse,
  PerformanceResponse,
  WANResponse,
  ClientListResponse,
  InternetResponse,
  ErrorResponse,
  LteIntfCfgResponse,
  LteLinkCfgResponse,
} from '../../lib/client';

// How long to retain a client in the tracked list without being seen (30 days)
const TRACKED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Mesh-wide "left" events are debounced by this many consecutive missed master polls
// (≈60s at the default 30s interval) to absorb the brief gap that can occur while a
// client re-associates with a different node during normal roaming.
const MESH_LEFT_GRACE_POLLS = 2;

export interface TrackedClient {
  mac: string;
  name: string;       // decoded (human-readable)
  ip: string;
  type: string;
  online: boolean;    // currently online on this Deco node
  lastSeen: number;   // unix ms — last time seen online
  firstSeen: number;  // unix ms — first time seen
  access_host?: string; // MAC of the Deco node this client is connected to
}

export interface MeshTrackedClient extends TrackedClient {
  missedPolls: number; // consecutive master polls without seeing this client anywhere in the mesh
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
  // One-shot timer IDs — cancelled in onDeleted to avoid post-deletion callbacks
  private rebootTimerId: ReturnType<typeof setTimeout> | null = null;
  private startupDelayTimerId: ReturnType<typeof setTimeout> | null = null;
  private api: decoapiwrapper | any;

  connected = false; // Connection status
  clients: any[] = []; // Currently online clients (raw, for state comparison)

  // Persistent client history — all clients seen in the last 30 days.
  // Keyed by MAC address. Public so driver.ts can use it for autocomplete.
  trackedClients: Record<string, TrackedClient> = {};

  // Mesh-wide client history — only populated on the master node, sourced from the
  // driver's merged per-node client lists (see getMeshClientList). Public so driver.ts
  // can read it for the global mesh-presence flow cards.
  meshTrackedClients: Record<string, MeshTrackedClient> = {};

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

  // Cache for which cellular API form name works on this device.
  // undefined = not yet probed, null = confirmed not supported,
  // string = form prefix (e.g. 'lte', '5g', 'nr'); forms are <prefix>_intf_cfg / <prefix>_link_cfg.
  private lteFormCache: string | null | undefined = undefined;

  // Guards the one-time "Auth method: ... model=... fw=..." report so it only
  // fires once per device per app run, not on every poll cycle.
  private authMethodReported = false;

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
      // Mesh-wide history is only ever written by the master node, but harmless to load on all
      this.meshTrackedClients = (this.getStoreValue('meshTrackedClients') as Record<string, MeshTrackedClient>) ?? {};

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
        // than retrying via auto-detect every time. Must apply unconditionally —
        // an explicitly cached `false` (this device needs form-urlencoded) used
        // to be silently dropped here, since the old code only ever set `true`
        // and otherwise left HttpClient's class default in place. That was
        // harmless while the default was also `false`, but stopped being safe
        // once the default flipped to `true` (see http.ts).
        const savedForceJson = (this.getStoreValue('forceJsonContentType') as boolean) ?? this.api.c.forceJsonContentType;
        this.api.c.forceJsonContentType = savedForceJson;
        this.log(`Restored content-type preference: ${savedForceJson ? 'application/json' : 'application/x-www-form-urlencoded'} (from store)`);

        // Authentication is deliberately NOT awaited here — it happens inside the
        // staggered startup timer below, right before the first poll. onInit()
        // must return quickly regardless of router/network conditions: awaiting
        // a slow or unreachable router here (the auth retry chain can take well
        // over 30s — content-type negotiation, password-format fallback, session
        // limit backoff) risks the device/app missing Homey's startup ready
        // window, surfacing as "Unable to initialize app Error: ready_timeout"
        // (seen in the field on the Live channel).

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
              this.rebootTimerId = setTimeout(async () => {
                this.rebootTimerId = null;
                try {
                  await this.setAvailable();
                  await this.setCapabilityValue('reboot', false).catch(this.error);
                } catch (e: any) {
                  this.log('Reboot timer: device already gone, skipping setAvailable', e?.message);
                }
              }, 60000); // 60 seconds
            } else {
              this.error('Failed to reboot');
            }
          }
        });

        // Pause/resume polling — lets users stop API calls entirely (e.g. while
        // troubleshooting a router session conflict, or to reduce load on
        // routers that struggle with sustained polling) without deleting the
        // device. Mirrors the pause/resume control other Deco integrations
        // (e.g. Home Assistant's) expose for the same reason.
        //
        // The capability is "active" rather than "paused" so the toggle's lit/on
        // state always means "running" — a lit toggle meaning "paused" reads
        // backwards to users (reported feedback after the first version of this
        // shipped as polling_paused).
        if (this.hasCapability('polling_active') && this.getCapabilityValue('polling_active') === null) {
          await this.setCapabilityValue('polling_active', true).catch(this.error);
        }
        this.registerCapabilityListener('polling_active', async (value) => {
          const active = Boolean(value);
          this.log(`Polling ${active ? 'resumed' : 'paused'} by user`);
          if (!active) {
            if (this.startupDelayTimerId) {
              clearTimeout(this.startupDelayTimerId);
              this.startupDelayTimerId = null;
            }
            if (this.timeoutSecondsIntervalId) {
              clearInterval(this.timeoutSecondsIntervalId);
              this.timeoutSecondsIntervalId = null;
            }
          } else {
            const resumedInterval = (this.getSettings().timeoutSeconds || 30) * 1000;
            try {
              await this.updateDeviceMetrics();
            } catch (e: any) {
              this.error('Resume poll failed', e);
            }
            this.setUpdateInterval(resumedInterval);
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

        // any_client_state_changed — fires for every state change, filtered only by status
        const anyClientStateFlow = this.homey.flow.getDeviceTriggerCard('any_client_state_changed');
        anyClientStateFlow.registerRunListener(async (args, state) => {
          return args.status === state.status;
        });

        // client_node_changed — fires when a specific client roams to a different Deco node
        const clientNodeChangedFlow = this.homey.flow.getDeviceTriggerCard('client_node_changed');
        clientNodeChangedFlow.registerRunListener(async (args, state) => {
          return args.client.mac === state.mac;
        });
        clientNodeChangedFlow.registerArgumentAutocompleteListener(
          'client',
          async (query, args) => {
            const driver = this.driver as TplinkDecoDriver;
            return driver.buildClientAutocomplete(this, query);
          },
        );

        if (this.getCapabilityValue('polling_active') === false) {
          this.log('Polling paused (restored from saved state) — skipping startup poll');
          return;
        }

        // Stagger first poll across devices to avoid simultaneous auth attempts.
        // The Deco allows only one session at a time — concurrent logins cause
        // HTTP 403 on all-but-one device. A random 0–15 s delay spreads them out.
        const interval = (settings.timeoutSeconds || 30) * 1000;
        const startupDelay = Math.floor(Math.random() * Math.min(interval, 15000));
        this.log(`First poll in ${startupDelay / 1000}s (stagger offset)`);
        this.startupDelayTimerId = setTimeout(async () => {
          this.startupDelayTimerId = null;
          try {
            if (!this.connected) {
              await this.reAuthenticate();
            }
            await this.updateDeviceMetrics();
            this.setUpdateInterval(interval);
          } catch (e: any) {
            this.log('Startup delay timer: device already gone, skipping', e?.message);
          }
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
        // Clear the stored content-type preference for new credentials — authenticate()
        // tries every contentType/bodyFormat/passwordMode combo regardless of where
        // forceJsonContentType currently sits, so there's no "common case" to bias
        // toward here; just drop the stale preference and let it re-detect.
        await this.unsetStoreValue('forceJsonContentType');
        this.connected = await driver.sharedAuthenticate(newSettings.hostname, newSettings.password, this.makeLogger());
        if (this.connected) {
          await this.setStoreValue('forceJsonContentType', this.api.c.forceJsonContentType);
        }
        this.log('API reinitialized with updated settings');
      } catch (error) {
        this.error('Failed to reinitialize API', error);
      }
    }

    // Update the interval if timeoutSeconds has changed (skip while paused —
    // the interval stays cleared until the user resumes via polling_active)
    if (changedKeys.includes('timeoutSeconds') && this.getCapabilityValue('polling_active') !== false) {
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

    if (this.rebootTimerId) {
      clearTimeout(this.rebootTimerId);
      this.rebootTimerId = null;
    }
    if (this.startupDelayTimerId) {
      clearTimeout(this.startupDelayTimerId);
      this.startupDelayTimerId = null;
    }
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
          // Report the settled auth method (Content-Type / body format / password
          // mode, all cached on this.api.c after the first successful login) paired
          // with this device's exact model/firmware. Building this up across users
          // in Sentry over time is the cheap alternative to asking for a fresh HAR
          // every time a new login quirk shows up — if a specific model/firmware
          // combo consistently needs unusual handling, this is how we'd notice
          // without already suspecting it. One report per device per app run.
          if (!this.authMethodReported) {
            this.authMethodReported = true;
            // Fixed message so every report dedupes into ONE Sentry issue —
            // reportIssue()/homey-log dedupes by exact message string, and a
            // per-model/firmware message here would instead spawn a brand new,
            // permanent issue for every device variant across all users (it did:
            // dozens of "Auth method: ..." issues appeared within minutes of
            // shipping this). The variant data goes in `extra` and is visible
            // per-event in Sentry without multiplying the issue list.
            (this.homey.app as any).reportIssue?.(
              'Auth method reported',
              {
                contentType: this.api.c.forceJsonContentType ? 'json' : 'urlencoded',
                bodyFormat: this.api.c.forceJsonBody ? 'json' : 'form',
                model: device.device_model,
                hardware_ver: device.hardware_ver,
                software_ver: device.software_ver,
              },
            );
          }

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
          let wanIpAddress: string | undefined;
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
            wanIpAddress = wanResponse?.result?.wan?.ip_info?.ip ?? '';
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

            const ipv4Disconnected = resolveWanDisconnected({
              nodeInternetStatus: device.inet_status,
              wanInternetStatus: internetResponse?.error_code === 0
                ? internetResponse.result?.ipv4?.inet_status
                : undefined,
              wanIpAddress,
            });
            if (ipv4Disconnected !== undefined) {
              await this.handleWanStateChange(
                'ipv4',
                ipv4Disconnected,
                this.savedWanipv4State ?? false,
                'alarm_wan_ipv4_state',
              );
            }

            if (internetResponse?.error_code === 0
              && internetResponse.result?.ipv6?.error_code === 0) {
              const ipv6Disconnected = resolveWanDisconnected({
                wanInternetStatus: internetResponse.result.ipv6.inet_status,
              });
              if (ipv6Disconnected !== undefined) {
                if (!this.hasCapability('alarm_wan_ipv6_state')) {
                  await this.addCapability('alarm_wan_ipv6_state');
                }
                await this.handleWanStateChange(
                  'ipv6',
                  ipv6Disconnected,
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

          // Feed this node's own client list into the driver's shared cache so the
          // master can build a mesh-wide view without a separate API call (see
          // getMeshClientList below — replaces the old device_mac: 'default' request,
          // which returned error_code=1 across ~14 models in our field telemetry).
          if (devicedata.id) {
            (this.driver as TplinkDecoDriver).setNodeClientList(settings.hostname, devicedata.id, clientList);
          }

          const clientNames = clientList
            .map((client) => (this.driver as TplinkDecoDriver).decodeNickname(client.name))
            .join(', ');
          await this.setSettings({ clients: clientNames });
          // Update capability with the number of connected clients
          await this.updateCapability('connected_clients', clientList.length);

          // Build a MAC → friendly-name map for the Deco nodes so the
          // client_node_changed token shows a human-readable name.
          const decoNodeNames = new Map<string, string>();
          for (const d of deviceList.result.device_list) {
            if (d.mac) {
              const nick = (this.driver as TplinkDecoDriver).resolveNickname(d);
              decoNodeNames.set(d.mac.toUpperCase(), nick ? `${d.device_model} - ${nick}` : (d.device_model || d.mac));
            }
          }

          // Handle client state changes
          await this.handleClientStateChanges(clientList, decoNodeNames);

          // Mesh-wide presence — master only. Previously fetched via a dedicated
          // device_mac: 'default' request, which returned error_code=1 across a
          // dozen+ models in our field telemetry (other Deco integrations document
          // 'default' as supported, so this may be firmware/model-specific rather
          // than universally invalid — see TplinkDecoDriver.nodeClientLists for
          // details). Build the mesh-wide view instead from the per-node client
          // lists every device already fetches for itself above (device_mac: <own
          // MAC>, confirmed working everywhere) — no extra API call needed either way.
          if (isMaster) {
            const meshClientList = (this.driver as TplinkDecoDriver).getMeshClientList(settings.hostname);
            this.log(`Mesh-wide client snapshot: clients=${meshClientList.length} (merged from ${deviceList.result.device_list.length} node(s))`);
            await this.handleMeshPresence(meshClientList, decoNodeNames);
          }

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

          // LTE data usage — auto-detected: capabilities are added/removed based on API response
          await this.updateLteMetrics((device as any).imei as string | undefined);
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
    disconnected: boolean,
    savedWanState: boolean,
    capabilityName: string,
  ) {
    try {
      const flowEvents = buildWanFlowEvents({
        cachedDisconnected: this.getCapabilityValue(capabilityName),
        fallbackDisconnected: savedWanState,
        currentDisconnected: disconnected,
        ipVersion,
      });

      this[`savedWan${ipVersion}State`] = disconnected;
      await this.updateCapability(capabilityName, disconnected);

      for (const event of flowEvents) {
        try {
          await this.homey.flow.getDeviceTriggerCard(event.cardId).trigger(this, event.tokens);
        } catch (flowError) {
          this.error(`Failed to trigger ${event.cardId}`, flowError);
        }
      }
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
   * @param decoNodeNames - Map of Deco node MAC (uppercase) → friendly display name.
   */
  private async handleClientStateChanges(clientList: any[], decoNodeNames: Map<string, string> = new Map()) {
    try {
      const clientStateFlow = this.homey.flow.getDeviceTriggerCard('client_state_changed');
      const anyClientStateFlow = this.homey.flow.getDeviceTriggerCard('any_client_state_changed');
      const clientFirstSeenFlow = this.homey.flow.getDeviceTriggerCard('client_first_seen');
      const clientNodeChangedFlow = this.homey.flow.getDeviceTriggerCard('client_node_changed');
      const now = Date.now();

      const resolveNodeName = (accessHost: string | undefined): string => {
        if (!accessHost) return '';
        return decoNodeNames.get(accessHost.toUpperCase()) ?? accessHost;
      };

      // Maps for quick lookup
      const lastClientsMap = new Map(
        this.clients?.map((client) => [client.mac, client]),
      );
      const currentClientsMap = new Map(
        clientList.map((client) => [client.mac, client]),
      );

      // Clients that have come online
      for (const [mac, client] of currentClientsMap) {
        const decodedName = (this.driver as TplinkDecoDriver).decodeNickname(client.name);
        const isFirstSeen = !this.trackedClients[mac];
        const previousAccessHost = this.trackedClients[mac]?.access_host;
        const currentAccessHost: string = client.access_host ?? '';

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
          access_host: currentAccessHost,
        };

        if (!lastClientsMap.has(mac)) {
          // Client came online — fire specific and generic cards
          await clientStateFlow.trigger(this, tokens, {
            status: 'online',
            client: tokens,
          });
          await anyClientStateFlow.trigger(this, { ...tokens, status: 'online' }, { status: 'online' });

          // Fire first-seen card if this client has never appeared before
          if (isFirstSeen) {
            await clientFirstSeenFlow.trigger(this, {
              name: decodedName,
              mac: client.mac,
              ipaddr: client.ip,
              connection_type: client.connection_type ?? '',
            });
          }
        }

        // Fire node-changed card if the client moved to a different Deco node
        if (
          !isFirstSeen &&
          currentAccessHost &&
          previousAccessHost &&
          currentAccessHost.toUpperCase() !== previousAccessHost.toUpperCase()
        ) {
          await clientNodeChangedFlow.trigger(
            this,
            {
              name: decodedName,
              mac: client.mac,
              deco_node: resolveNodeName(currentAccessHost),
              previous_node: resolveNodeName(previousAccessHost),
            },
            { mac: client.mac },
          );
        }
      }

      // Clients that have gone offline
      for (const [mac, client] of lastClientsMap) {
        if (!currentClientsMap.has(mac)) {
          const decodedName = (this.driver as TplinkDecoDriver).decodeNickname(client.name);
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
          await anyClientStateFlow.trigger(this, { ...tokens, status: 'offline' }, { status: 'offline' });
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
   * Handles mesh-wide presence by comparing the current mesh-wide client list (merged
   * from each node's own client list, master only) against the persistent
   * meshTrackedClients history. Fires the global client_joined_mesh / client_left_mesh
   * triggers.
   *
   * "Left" is debounced by MESH_LEFT_GRACE_POLLS consecutive misses so a client that
   * briefly drops out while re-associating with a different node during normal roaming
   * does not produce a false leave/join pair.
   * @param meshClientList - Every client currently connected anywhere in the mesh.
   * @param decoNodeNames - Map of Deco node MAC (uppercase) → friendly display name.
   */
  private async handleMeshPresence(meshClientList: any[], decoNodeNames: Map<string, string> = new Map()) {
    try {
      const joinedFlow = this.homey.flow.getTriggerCard('client_joined_mesh');
      const leftFlow = this.homey.flow.getTriggerCard('client_left_mesh');
      const now = Date.now();

      const currentClientsMap = new Map(
        meshClientList.map((client) => [client.mac, client]),
      );

      // Clients present now — joined if they weren't considered online before
      for (const [mac, client] of currentClientsMap) {
        const decodedName = (this.driver as TplinkDecoDriver).decodeNickname(client.name);
        const wasOnline = this.meshTrackedClients[mac]?.online === true;
        const currentAccessHost: string = client.access_host ?? '';

        const tokens = {
          name: decodedName,
          ipaddr: client.ip,
          mac: client.mac,
          connection_type: client.connection_type ?? '',
          deco_node: decoNodeNames.get(currentAccessHost.toUpperCase()) ?? currentAccessHost,
        };

        this.meshTrackedClients[mac] = {
          mac: client.mac,
          name: decodedName,
          ip: client.ip,
          type: client.client_type ?? '',
          online: true,
          lastSeen: now,
          firstSeen: this.meshTrackedClients[mac]?.firstSeen ?? now,
          access_host: currentAccessHost,
          missedPolls: 0,
        };

        if (!wasOnline) {
          await joinedFlow.trigger(tokens, { mac: client.mac });
        }
      }

      // Clients tracked as online but absent from this snapshot — debounce before declaring left
      for (const [mac, tracked] of Object.entries(this.meshTrackedClients)) {
        if (tracked.online && !currentClientsMap.has(mac)) {
          tracked.missedPolls += 1;
          if (tracked.missedPolls >= MESH_LEFT_GRACE_POLLS) {
            tracked.online = false;
            await leftFlow.trigger(
              {
                name: tracked.name,
                ipaddr: tracked.ip,
                mac: tracked.mac,
              },
              { mac: tracked.mac },
            );
          }
        }
      }

      // Prune clients not seen for more than 30 days
      for (const [mac, tracked] of Object.entries(this.meshTrackedClients)) {
        if (!tracked.online && now - tracked.lastSeen > TRACKED_CLIENT_TTL_MS) {
          delete this.meshTrackedClients[mac];
        }
      }

      await this.setStoreValue('meshTrackedClients', this.meshTrackedClients);
    } catch (err) {
      this.error('Failed to handle mesh presence', err);
    }
  }

  /**
   * Fetches cellular data-usage and connection-status metrics and updates capabilities.
   * Capabilities are added dynamically when the router responds with valid data
   * and removed if no working endpoint is found (non-cellular models).
   *
   * Probes two endpoint families on first call:
   *   lte_intf_cfg / lte_link_cfg  — 4G LTE models (e.g. X50-4G)
   *   5g_intf_cfg  / 5g_link_cfg   — 5G NR  models (e.g. X50-5G, if supported)
   * The working family is cached in lteFormCache so subsequent polls use it directly.
   *
   * Note on units: TP-Link firmware typically reports curStatistics / totalStatistics
   * in MB. The raw values are logged so unexpected values can be reported.
   */
  private async updateLteMetrics(imei?: string): Promise<void> {
    const LTE_CAPS = [
      'measure_lte_monthly_rx_mb',
      'measure_lte_monthly_tx_mb',
      'lte_sim_status',
      'lte_network_type',
    ] as const;

    const removeCaps = async () => {
      for (const cap of LTE_CAPS) {
        if (this.hasCapability(cap)) await this.removeCapability(cap);
      }
    };

    const defaultResp = { error_code: 1, result: {} };
    const hasData = (r: { error_code: number; result: any }) =>
      r.error_code === 0 && r.result != null && Object.keys(r.result).length > 0;

    // Fast path: already confirmed this device has no cellular API
    if (this.lteFormCache === null) {
      await removeCaps();
      return;
    }

    let intfCfg: LteIntfCfgResponse;
    let linkCfg: LteLinkCfgResponse;

    if (this.lteFormCache === undefined) {
      // --- First call: probe which endpoint family works ---
      // Always try 'lte' first (works for all 4G models).
      // On cellular models (IMEI present), also probe '5g' and 'nr' (5G NR).
      const probePrefixes = imei ? ['lte', '5g', 'nr'] : ['lte'];
      let detectedIntfCfg: LteIntfCfgResponse | undefined;

      for (const prefix of probePrefixes) {
        // silent=true: 2 of 3 prefixes failing with "no such callback" is the
        // expected outcome here (a model only supports one of lte/5g/nr, if
        // any) — not worth logging as an error on every poll cycle.
        const probe = await this.safeApiCall<LteIntfCfgResponse>(
          () => this.api.custom('/admin/network', { form: `${prefix}_intf_cfg` }, this.readBody, true),
          defaultResp,
          `${prefix}_intf_cfg probe`,
        );
        if (hasData(probe)) {
          this.lteFormCache = prefix;
          this.log(`updateLteMetrics: ${prefix}_intf_cfg works — caching cellular endpoint as "${prefix}"`);
          detectedIntfCfg = probe;
          break;
        }
      }

      if (!detectedIntfCfg) {
        this.lteFormCache = null;
        if (imei) {
          this.log(
            `updateLteMetrics: cellular model (IMEI ${imei}) has no LTE/5G/NR API endpoint — capabilities unavailable`,
          );
        }
        await removeCaps();
        return;
      }

      intfCfg = detectedIntfCfg;

      // Fetch the link config for the discovered family
      const linkForm = `${this.lteFormCache}_link_cfg`;
      linkCfg = await this.safeApiCall<LteLinkCfgResponse>(
        () => this.api.custom('/admin/network', { form: linkForm }, this.readBody),
        defaultResp,
        linkForm,
      );
    } else {
      // --- Subsequent calls: use cached form directly ---
      const prefix = this.lteFormCache as string;
      const intfForm = `${prefix}_intf_cfg`;
      const linkForm = `${prefix}_link_cfg`;

      intfCfg = await this.safeApiCall<LteIntfCfgResponse>(
        () => this.api.custom('/admin/network', { form: intfForm }, this.readBody),
        defaultResp,
        intfForm,
      );
      linkCfg = await this.safeApiCall<LteLinkCfgResponse>(
        () => this.api.custom('/admin/network', { form: linkForm }, this.readBody),
        defaultResp,
        linkForm,
      );

      if (!hasData(intfCfg)) {
        // Endpoint stopped responding — reset cache so next poll re-probes
        this.lteFormCache = undefined;
        await removeCaps();
        return;
      }
    }

    // Add capabilities on first detection
    for (const cap of LTE_CAPS) {
      if (!this.hasCapability(cap)) await this.addCapability(cap);
    }

    // Parse usage values — firmware reports in MB (as string or number)
    const toMb = (v: string | number | undefined): number => {
      const n = Number(v ?? 0);
      return isNaN(n) ? 0 : Math.round(n * 10) / 10;
    };

    // curStatistics  = current billing-period total usage (combined RX+TX) in MB
    // totalStatistics = cumulative total since device reset — map to TX cap so users
    //                   can calculate the delta themselves in flows if needed.
    // curRxSpeed / curTxSpeed = instantaneous speeds (not stored separately here).
    // Log raw values — report unexpected numbers so unit handling can be adjusted.
    const rxMb = toMb(intfCfg.result.curStatistics);
    const txMb = toMb(intfCfg.result.totalStatistics);
    this.log(
      `LTE/5G stats raw: curStatistics=${intfCfg.result.curStatistics}` +
      ` totalStatistics=${intfCfg.result.totalStatistics}` +
      ` curRxSpeed=${intfCfg.result.curRxSpeed} curTxSpeed=${intfCfg.result.curTxSpeed}`,
    );

    await this.updateCapability('measure_lte_monthly_rx_mb', rxMb);
    await this.updateCapability('measure_lte_monthly_tx_mb', txMb);

    // Normalise SIM status strings from firmware (e.g. "sim_ready" → "Ready")
    const simRaw = (linkCfg as LteLinkCfgResponse).result?.simStatus ?? '';
    const simLabel = simRaw
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase()) || '–';
    await this.updateCapability('lte_sim_status', simLabel);

    const networkRaw = (linkCfg as LteLinkCfgResponse).result?.networkType ?? '';
    const networkLabel = networkRaw.toUpperCase() || '–';
    await this.updateCapability('lte_network_type', networkLabel);
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
