import crypto from 'crypto';
import { Device } from 'homey';
import DecoAPIWrapper from '../../lib/client';
import {
  normalizePollIntervalSeconds,
  SingleFlightTask,
  tryApiCall,
} from '../../lib/polling';
import { redactSensitiveData } from '../../lib/redaction';
import { assertDangerousActionAllowed } from '../../lib/action-safety';
import {
  DecoFeatureController,
  RadioFeature,
  RadioFeatureSnapshot,
  SpeedTestSnapshot,
  WirelessNetworkKind,
  WirelessSnapshot,
} from '../../lib/deco-features';
import {
  buildBackhaulDiagnostic,
  buildClientStatistics,
  countPrioritizedClients,
  normalizeClientMac,
  normalizePauseDurationMinutes,
} from '../../lib/advanced-controls';
import {
  MeshClientEvent,
  MeshTrackedClient,
  NodeClientEvent,
  TrackedClient,
  reconcileMeshClients,
  reconcileNodeClients,
} from '../../lib/client-tracker';
import { MasterFeatureCoordinator } from '../../lib/master-feature-coordinator';
import { DecoPollReader } from '../../lib/deco-poll-reader';
// Type-only import to access the driver's shared-auth methods without a circular dep
type TplinkDecoDriver = import('./driver').TplinkDecoDriver;
import { DecoClient, LteIntfCfgResponse, LteLinkCfgResponse } from '../../lib/client';

const MASTER_FEATURE_CAPABILITIES = [
  'wan_ipv4_uptime',
  'wifi_main_ssid',
  'wifi_bands',
  'guest_wifi_enabled',
  'guest_wifi_ssid',
  'iot_wifi_enabled',
  'iot_wifi_ssid',
  'mlo_wifi_enabled',
  'mlo_wifi_ssid',
  'alarm_firmware_update',
  'latest_firmware_version',
  'prioritized_clients',
  'fast_roaming_enabled',
  'beamforming_enabled',
  'speedtest_status',
  'measure_speedtest_download_mbps',
  'measure_speedtest_upload_mbps',
  'measure_speedtest_ping_ms',
  'measure_speedtest_jitter_ms',
  'last_speedtest_at',
];
const PERFORMANCE_POLL_INTERVAL_MS = 5 * 60 * 1000;
const PERSISTENCE_CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

function formatUptime(rawSeconds: unknown): string {
  const totalSeconds = Number(rawSeconds);
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '–';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

interface PausedClient {
  restoreAt: number;
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

  // Recursive one-shot timer for periodic updates. Using setTimeout after each
  // completed poll prevents slow router responses from creating overlapping polls.
  private pollTimerId: ReturnType<typeof setTimeout> | null = null;
  private pollGate = new SingleFlightTask();
  private consecutivePollFailures = 0;
  // One-shot timer IDs — cancelled in onDeleted to avoid post-deletion callbacks
  private rebootTimerId: ReturnType<typeof setTimeout> | null = null;
  private startupDelayTimerId: ReturnType<typeof setTimeout> | null = null;
  private pauseTimerIds = new Map<string, ReturnType<typeof setTimeout>>();
  private pausedClients: Record<string, PausedClient> = {};
  private api!: DecoAPIWrapper;
  private pollReader!: DecoPollReader;
  private featureController: DecoFeatureController | undefined;
  private masterFeatureCoordinator: MasterFeatureCoordinator | undefined;
  private lastPerformancePollAt = 0;
  private lastTrackedClientsPersistAt = 0;
  private lastMeshClientsPersistAt = 0;
  private wirelessSnapshot: WirelessSnapshot | undefined;
  private configuredAsMaster: boolean | undefined;
  private apiRoleReported = false;
  private savedBackhaulDegraded: boolean | undefined;

  connected = false; // Connection status
  clients: DecoClient[] = []; // Currently online clients (raw, for state comparison)

  // Persistent client history — all clients seen in the last 30 days.
  // Keyed by MAC address. Public so driver.ts can use it for autocomplete.
  trackedClients: Record<string, TrackedClient> = {};

  // Mesh-wide client history — only populated on the master node, sourced from the
  // driver's merged per-node client snapshot. Public so driver.ts
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
      this.pausedClients = (this.getStoreValue('pausedClients') as Record<string, PausedClient>) ?? {};

      // Retrieve device settings
      const settings = this.getSettings();
      this.debug('Settings:', redactSensitiveData(settings));

      if (this.hasCapability('alarm_wan_ipv6_state')) {
        await this.removeCapability('alarm_wan_ipv6_state');
      }

      const initIsMaster = (settings.role ?? '').toLowerCase() === 'master';
      await this.syncRoleCapabilities(initIsMaster);
      for (const cap of [
        'connected_clients_guest',
        'connected_clients_iot',
        'connected_clients_mlo',
      ]) {
        if (!this.hasCapability(cap)) await this.addCapability(cap);
      }

      // Check if hostname and password are provided
      if (settings.hostname && settings.password) {
        // Use the driver's shared API instance for this hostname.
        // All device instances on the same master share ONE session —
        // the Deco only allows one active login at a time.
        const driver = this.driver as TplinkDecoDriver;
        this.api = driver.getOrCreateSharedApi(settings.hostname);
        this.pollReader = new DecoPollReader(this.api, {
          error: (message, error) => this.error(message, error),
        });
        this.featureController = new DecoFeatureController(this.api);
        this.masterFeatureCoordinator = this.createMasterFeatureCoordinator(this.featureController);
        this.restoreClientPauseTimers();

        // Restore the previously-detected content-type preference so the first
        // auth attempt on restart already uses the known-good encoding rather
        // than retrying via auto-detect every time. Must apply unconditionally —
        // an explicitly cached `false` (this device needs form-urlencoded) used
        // to be silently dropped here, since the old code only ever set `true`
        // and otherwise left HttpClient's class default in place. That was
        // harmless while the default was also `false`, but stopped being safe
        // once the default flipped to `true` (see http.ts).
        const savedForceJson = (this.getStoreValue('forceJsonContentType') as boolean)
          ?? (this.api.getAuthPreferences().contentType === 'json');
        this.api.setContentTypePreference(savedForceJson);
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
            try {
              assertDangerousActionAllowed(this.getSettings());
            } catch (error) {
              await this.setCapabilityValue('reboot', false).catch(this.error);
              throw error;
            }
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
            if (this.pollTimerId) {
              clearTimeout(this.pollTimerId);
              this.pollTimerId = null;
            }
            this.masterFeatureCoordinator?.stop();
          } else {
            const resumedInterval = normalizePollIntervalSeconds(
              this.getSettings().timeoutSeconds,
            ) * 1000;
            await this.runPollCycle();
            this.setUpdateInterval(resumedInterval);
          }
        });

        if (initIsMaster) {
          this.registerWirelessCapabilityListener('guest_wifi_enabled', 'guest');
          this.registerWirelessCapabilityListener('iot_wifi_enabled', 'iot');
          this.registerWirelessCapabilityListener('mlo_wifi_enabled', 'mlo');
          this.registerRadioCapabilityListener('fast_roaming_enabled', 'fastRoaming');
          this.registerRadioCapabilityListener('beamforming_enabled', 'beamforming');
        }

        if (this.getCapabilityValue('polling_active') === false) {
          this.log('Polling paused (restored from saved state) — skipping startup poll');
          return;
        }

        // Stagger first poll across devices to avoid simultaneous auth attempts.
        // The Deco allows only one session at a time — concurrent logins cause
        // HTTP 403 on all-but-one device. A random 0–15 s delay spreads them out.
        const interval = normalizePollIntervalSeconds(settings.timeoutSeconds) * 1000;
        const startupDelay = Math.floor(Math.random() * Math.min(interval, 15000));
        this.log(`First poll in ${startupDelay / 1000}s (stagger offset)`);
        this.startupDelayTimerId = setTimeout(async () => {
          this.startupDelayTimerId = null;
          try {
            if (!this.connected) {
              await this.reAuthenticate();
            }
            await this.runPollCycle();
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

  private registerWirelessCapabilityListener(
    capability: string,
    kind: WirelessNetworkKind,
  ): void {
    if (!this.hasCapability(capability)) return;
    this.registerCapabilityListener(capability, async (value) => {
      await this.setWirelessNetworkEnabled(kind, Boolean(value));
    });
  }

  private registerRadioCapabilityListener(capability: string, feature: RadioFeature): void {
    this.registerCapabilityListener(capability, async (value) => {
      await this.setRadioFeatureEnabled(feature, Boolean(value));
    });
  }

  private async syncRoleCapabilities(isMaster: boolean): Promise<void> {
    const satelliteCapabilities = [
      'signal_strength_2g',
      'signal_strength_5g',
      'signal_strength_6g',
      'backhaul_connection',
      'backhaul_parent',
      'alarm_backhaul_degraded',
    ];
    for (const capability of satelliteCapabilities) {
      if (isMaster && this.hasCapability(capability)) {
        await this.removeCapability(capability);
      } else if (!isMaster && !this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }

    const masterCapabilities = [
      'measure_cpu_usage',
      'measure_mem_usage',
      'alarm_wan_ipv4_state',
      'wan_ipv4_ipaddr',
      ...MASTER_FEATURE_CAPABILITIES,
    ];
    for (const capability of masterCapabilities) {
      if (!isMaster && this.hasCapability(capability)) {
        await this.removeCapability(capability);
      } else if (isMaster && !this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
    this.configuredAsMaster = isMaster;
  }

  public async setWirelessNetworkEnabled(
    kind: WirelessNetworkKind,
    enabled: boolean,
  ): Promise<void> {
    assertDangerousActionAllowed(this.getSettings());
    if (!this.featureController) throw new Error('Deco feature controller is not initialized.');
    if (!this.connected && !await this.reAuthenticate()) {
      throw new Error('Could not authenticate with the Deco.');
    }

    const previous = this.wirelessSnapshot;
    try {
      const snapshot = await this.featureController.setWirelessEnabled(kind, enabled);
      await this.applyWirelessSnapshot(snapshot);
      this.log(`${kind} Wi-Fi ${enabled ? 'enabled' : 'disabled'} by user`);
    } catch (error) {
      if (previous) await this.applyWirelessSnapshot(previous);
      throw error;
    }
  }

  public async setClientInternetAccess(mac: string, allowed: boolean): Promise<void> {
    assertDangerousActionAllowed(this.getSettings());
    if (!this.featureController) throw new Error('Deco feature controller is not initialized.');
    if (!this.connected && !await this.reAuthenticate()) {
      throw new Error('Could not authenticate with the Deco.');
    }
    await this.featureController.setClientAccess(mac, allowed);
    await this.cancelClientPause(mac);
    this.log(`Client internet access ${allowed ? 'restored' : 'blocked'} for ${mac}`);
    await this.refreshNow();
  }

  public async setRadioFeatureEnabled(feature: RadioFeature, enabled: boolean): Promise<void> {
    if (this.configuredAsMaster === false) {
      throw new Error('Radio features can only be changed from the main Deco device.');
    }
    assertDangerousActionAllowed(this.getSettings());
    if (!this.featureController) throw new Error('Deco feature controller is not initialized.');
    if (!this.connected && !await this.reAuthenticate()) {
      throw new Error('Could not authenticate with the Deco.');
    }
    const snapshot = await this.featureController.setRadioFeature(feature, enabled);
    await this.applyRadioFeatureSnapshot(feature, snapshot);
    this.log(`${feature} ${enabled ? 'enabled' : 'disabled'} by user`);
  }

  public async runInternetSpeedTest(): Promise<void> {
    if (this.configuredAsMaster === false) {
      throw new Error('Internet speed tests can only be started from the main Deco device.');
    }
    assertDangerousActionAllowed(this.getSettings());
    if (!this.masterFeatureCoordinator) throw new Error('Deco feature coordinator is not initialized.');
    if (!this.connected && !await this.reAuthenticate()) {
      throw new Error('Could not authenticate with the Deco.');
    }
    await this.masterFeatureCoordinator.startSpeedTest();
    this.log('Internet speed test started by user');
  }

  public getClientStatistics(mac: string): ReturnType<typeof buildClientStatistics> {
    const normalizedMac = normalizeClientMac(mac);
    const source = this.configuredAsMaster && Object.keys(this.meshTrackedClients).length > 0
      ? this.meshTrackedClients
      : this.trackedClients;
    const client = source[normalizedMac]
      ?? source[mac]
      ?? Object.values(source).find((candidate) => (
        candidate.mac?.replace(/:/g, '-').toUpperCase() === normalizedMac
      ));
    if (!client) throw new Error(`Client ${normalizedMac} has not been seen by this Deco.`);
    return buildClientStatistics(client);
  }

  public async pauseClientInternetAccess(mac: string, durationMinutes: unknown): Promise<void> {
    assertDangerousActionAllowed(this.getSettings());
    if (!this.featureController) throw new Error('Deco feature controller is not initialized.');
    if (!this.connected && !await this.reAuthenticate()) {
      throw new Error('Could not authenticate with the Deco.');
    }

    const normalizedMac = normalizeClientMac(mac);
    const duration = normalizePauseDurationMinutes(durationMinutes);
    await this.featureController.setClientAccess(normalizedMac, false);
    await this.cancelClientPause(normalizedMac);
    const restoreAt = Date.now() + duration * 60 * 1000;
    this.pausedClients[normalizedMac] = { restoreAt };
    this.scheduleClientPauseTimer(normalizedMac, restoreAt);
    try {
      await this.setStoreValue('pausedClients', this.pausedClients);
    } catch (error) {
      await this.cancelClientPause(normalizedMac);
      await this.featureController.setClientAccess(normalizedMac, true)
        .catch((restoreError) => this.error('Failed to roll back client pause', restoreError));
      throw error;
    }
    this.log(`Client internet paused for ${duration} minute(s): ${normalizedMac}`);
    await this.refreshNow();
  }

  private restoreClientPauseTimers(): void {
    for (const [mac, pause] of Object.entries(this.pausedClients)) {
      if (!Number.isFinite(pause?.restoreAt)) {
        delete this.pausedClients[mac];
        continue;
      }
      this.scheduleClientPauseTimer(mac, pause.restoreAt);
    }
    void this.setStoreValue('pausedClients', this.pausedClients);
  }

  private scheduleClientPauseTimer(mac: string, restoreAt: number, retryDelayMs?: number): void {
    const existingTimer = this.pauseTimerIds.get(mac);
    if (existingTimer) clearTimeout(existingTimer);
    const delay = retryDelayMs ?? Math.max(0, restoreAt - Date.now());
    const timer = setTimeout(() => {
      this.pauseTimerIds.delete(mac);
      void this.restorePausedClient(mac);
    }, delay);
    this.pauseTimerIds.set(mac, timer);
  }

  private async restorePausedClient(mac: string): Promise<void> {
    try {
      if (!this.featureController) throw new Error('Deco feature controller is not initialized.');
      if (!this.connected && !await this.reAuthenticate()) {
        throw new Error('Could not authenticate with the Deco.');
      }
      await this.featureController.setClientAccess(mac, true);
      delete this.pausedClients[mac];
      await this.setStoreValue('pausedClients', this.pausedClients);
      this.log(`Client internet automatically restored: ${mac}`);
      await this.refreshNow();
    } catch (error) {
      if (!Object.hasOwn(this.pausedClients, mac)) return;
      this.error(`Failed to restore paused client ${mac}; retrying in 60 seconds`, error);
      this.scheduleClientPauseTimer(mac, this.pausedClients[mac]?.restoreAt ?? Date.now(), 60000);
    }
  }

  private async cancelClientPause(mac: string): Promise<void> {
    const normalizedMac = normalizeClientMac(mac);
    const timer = this.pauseTimerIds.get(normalizedMac);
    if (timer) clearTimeout(timer);
    this.pauseTimerIds.delete(normalizedMac);
    if (!Object.hasOwn(this.pausedClients, normalizedMac)) return;
    delete this.pausedClients[normalizedMac];
    await this.setStoreValue('pausedClients', this.pausedClients);
  }

  public async refreshNow(): Promise<void> {
    if (!this.connected && !await this.reAuthenticate()) {
      throw new Error('Could not authenticate with the Deco.');
    }
    this.masterFeatureCoordinator?.resetPollSchedule();
    this.lastPerformancePollAt = 0;
    await this.runPollCycle();
  }

  private async applyRadioFeatureSnapshot(
    feature: RadioFeature,
    snapshot: RadioFeatureSnapshot,
  ): Promise<void> {
    const capability = feature === 'fastRoaming' ? 'fast_roaming_enabled' : 'beamforming_enabled';
    if (!snapshot.supported) {
      if (this.hasCapability(capability)) await this.removeCapability(capability);
      return;
    }
    if (!this.hasCapability(capability)) await this.addCapability(capability);
    await this.updateCapability(capability, snapshot.enabled);
  }

  private createMasterFeatureCoordinator(
    controller: DecoFeatureController,
  ): MasterFeatureCoordinator {
    return new MasterFeatureCoordinator(
      controller,
      {
        wireless: (snapshot) => this.applyWirelessSnapshot(snapshot),
        radio: (feature, snapshot) => this.applyRadioFeatureSnapshot(feature, snapshot),
        firmware: async (snapshot) => {
          await this.updateCapability('alarm_firmware_update', snapshot.available);
          await this.updateCapability('latest_firmware_version', snapshot.version || 'Up to date');
        },
        speedTest: {
          apply: (snapshot) => this.applySpeedTestSnapshot(snapshot),
          completed: async (snapshot) => {
            await this.homey.flow.getDeviceTriggerCard('speedtest_completed').trigger(this, {
              download_mbps: snapshot.downMbps,
              upload_mbps: snapshot.upMbps,
              ping_ms: snapshot.pingMs,
              jitter_ms: snapshot.jitterMs,
              completed_at: snapshot.lastRunAt,
            });
          },
          failed: (error) => this.error('Failed to poll active speed test', error),
        },
        failed: (feature, error) => this.error(`Failed to retrieve ${feature}`, error),
      },
      (task) => this.pollGate.run(task),
    );
  }

  private async applySpeedTestSnapshot(snapshot: SpeedTestSnapshot): Promise<void> {
    const capabilities = [
      'speedtest_status',
      'measure_speedtest_download_mbps',
      'measure_speedtest_upload_mbps',
      'measure_speedtest_ping_ms',
      'measure_speedtest_jitter_ms',
      'last_speedtest_at',
    ];
    if (!snapshot.supported) {
      for (const capability of capabilities) {
        if (this.hasCapability(capability)) await this.removeCapability(capability);
      }
      return;
    }
    for (const capability of capabilities) {
      if (!this.hasCapability(capability)) await this.addCapability(capability);
    }
    await this.updateCapability('speedtest_status', snapshot.status);
    await this.updateCapability('measure_speedtest_download_mbps', snapshot.downMbps);
    await this.updateCapability('measure_speedtest_upload_mbps', snapshot.upMbps);
    await this.updateCapability('measure_speedtest_ping_ms', snapshot.pingMs);
    await this.updateCapability('measure_speedtest_jitter_ms', snapshot.jitterMs);
    await this.updateCapability('last_speedtest_at', snapshot.lastRunAt || '–');
  }

  private async applyWirelessSnapshot(snapshot: WirelessSnapshot): Promise<void> {
    this.wirelessSnapshot = snapshot;
    await this.updateCapability('wifi_main_ssid', snapshot.mainSsid || '–');
    await this.updateCapability('wifi_bands', snapshot.supportedBands.join(' + ') || '–');

    const networks: Array<{
      supported: boolean;
      enabledCapability: string;
      ssidCapability: string;
      enabled: boolean;
      ssid: string;
    }> = [
      {
        supported: snapshot.guestSupported,
        enabledCapability: 'guest_wifi_enabled',
        ssidCapability: 'guest_wifi_ssid',
        enabled: snapshot.guestEnabled,
        ssid: snapshot.guestSsid,
      },
      {
        supported: snapshot.iotSupported,
        enabledCapability: 'iot_wifi_enabled',
        ssidCapability: 'iot_wifi_ssid',
        enabled: snapshot.iotEnabled,
        ssid: snapshot.iotSsid,
      },
      {
        supported: snapshot.mloSupported,
        enabledCapability: 'mlo_wifi_enabled',
        ssidCapability: 'mlo_wifi_ssid',
        enabled: snapshot.mloEnabled,
        ssid: snapshot.mloSsid,
      },
    ];

    for (const network of networks) {
      if (!network.supported) {
        for (const capability of [network.enabledCapability, network.ssidCapability]) {
          if (this.hasCapability(capability)) await this.removeCapability(capability);
        }
        continue;
      }
      for (const capability of [network.enabledCapability, network.ssidCapability]) {
        if (!this.hasCapability(capability)) await this.addCapability(capability);
      }
      await this.updateCapability(network.enabledCapability, network.enabled);
      await this.updateCapability(network.ssidCapability, network.ssid || '–');
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
        this.api = driver.getOrCreateSharedApi(newSettings.hostname);
        this.pollReader = new DecoPollReader(this.api, {
          error: (message, error) => this.error(message, error),
        });
        this.featureController = new DecoFeatureController(this.api);
        this.masterFeatureCoordinator?.stop();
        this.masterFeatureCoordinator = this.createMasterFeatureCoordinator(this.featureController);
        this.lastPerformancePollAt = 0;
        // Clear the stored content-type preference for new credentials — authenticate()
        // tries every contentType/bodyFormat/passwordMode combo regardless of where
        // forceJsonContentType currently sits, so there's no "common case" to bias
        // toward here; just drop the stale preference and let it re-detect.
        await this.unsetStoreValue('forceJsonContentType');
        this.connected = await driver.sharedAuthenticate(
          newSettings.hostname,
          newSettings.password,
          true,
        );
        if (this.connected) {
          await this.setStoreValue(
            'forceJsonContentType',
            this.api.getAuthPreferences().contentType === 'json',
          );
        }
        this.log('API reinitialized with updated settings');
      } catch (error) {
        this.error('Failed to reinitialize API', error);
        await this.setUnavailable('The updated TP-Link Deco credentials were rejected')
          .catch((availabilityError) => this.error('Failed to mark device unavailable', availabilityError));
        throw error;
      }
    }

    // Update the interval if timeoutSeconds has changed (skip while paused —
    // the interval stays cleared until the user resumes via polling_active)
    if (changedKeys.includes('timeoutSeconds') && this.getCapabilityValue('polling_active') !== false) {
      const interval = normalizePollIntervalSeconds(newSettings.timeoutSeconds) * 1000;
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
    if (this.pollTimerId) {
      clearTimeout(this.pollTimerId);
      this.log('Cleared timer for device metrics update');
      this.pollTimerId = null;
    }
    this.masterFeatureCoordinator?.stop();
    for (const timer of this.pauseTimerIds.values()) clearTimeout(timer);
    this.pauseTimerIds.clear();
    if (Object.keys(this.pausedClients).length > 0 && !this.connected) {
      await this.reAuthenticate();
    }
    for (const mac of Object.keys(this.pausedClients)) {
      await this.featureController?.setClientAccess(mac, true)
        .catch((error) => this.error(`Failed to restore paused client during removal: ${mac}`, error));
    }
    this.pausedClients = {};
    await this.unsetStoreValue('pausedClients')
      .catch((error) => this.error('Failed to clear paused-client state', error));
  }

  /**
   * Sets up or updates the interval for updating device metrics.
   * @param interval - The interval in milliseconds.
   */
  private setUpdateInterval(interval: number) {
    if (this.pollTimerId) {
      clearTimeout(this.pollTimerId);
      this.pollTimerId = null;
    }

    const safeInterval = normalizePollIntervalSeconds(interval / 1000) * 1000;
    const delay = safeInterval + Math.random() * 5000;
    this.pollTimerId = setTimeout(async () => {
      this.pollTimerId = null;
      if (this.getCapabilityValue('polling_active') === false) return;
      await this.runPollCycle();
      if (this.getCapabilityValue('polling_active') !== false) {
        this.setUpdateInterval(safeInterval);
      }
    }, delay);
    this.log(`Set update interval to ${safeInterval / 1000} seconds`);
  }

  private async runPollCycle(): Promise<void> {
    const result = await this.pollGate.run(() => this.updateDeviceMetrics());
    if (!result.started) {
      this.log('Skipping overlapping device metrics poll');
    }
  }

  /**
   * Re-authenticates the API session when the STOK has expired.
   * Returns true if re-authentication succeeded.
   */
  private async reAuthenticate(force = false): Promise<boolean> {
    try {
      const settings = this.getSettings();
      this.log('Session expired, re-authenticating...');
      const driver = this.driver as TplinkDecoDriver;
      // Use the shared serialised auth — if another device is already
      // authenticating, we wait for the same result instead of racing.
      this.connected = await driver.sharedAuthenticate(
        settings.hostname,
        settings.password,
        force,
      );
      if (this.connected) {
        // Persist the content-type preference that worked so restarts skip re-detection.
        await this.setStoreValue(
          'forceJsonContentType',
          this.api.getAuthPreferences().contentType === 'json',
        );
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

      const performanceDue = Date.now() - this.lastPerformancePollAt
        >= PERFORMANCE_POLL_INTERVAL_MS;
      const poll = await this.pollReader.read(devicedata.id, performanceDue);
      if (poll.status === 'authentication-required') {
        const reauthenticated = await this.reAuthenticate(true);
        if (!reauthenticated) await this.markPollFailed();
        return;
      }
      if (poll.status === 'device-missing') {
        const reason = poll.nodes.length === 0
          ? 'Deco returned an empty device_list'
          : `Paired Deco ${devicedata.id} was not present in device_list`;
        this.error(reason);
        await this.markPollFailed();
        return;
      }

      if (poll.isMaster && performanceDue) this.lastPerformancePollAt = Date.now();
      const deviceList = { result: { device_list: poll.nodes } };
      this.debug(`${settings.hostname} poll snapshot: `, poll);

      if (deviceList.result.device_list.length > 0) {
        // Filter the device list to find the current device
        const device = poll.node;

        this.debug(`${settings.hostname} onInit():Filtered device: `, device);

        if (device) {
          // Report the settled auth method (Content-Type / body format / password
          // mode, all cached on this.api.c after the first successful login) paired
          // with this device's exact model/firmware. Building this up across users
          // in remote diagnostics over time is the cheap alternative to asking for a fresh HAR
          // every time a new login quirk shows up — if a specific model/firmware
          // combo consistently needs unusual handling, this is how we'd notice
          // without already suspecting it. One report per device per app run.
          if (!this.authMethodReported) {
            this.authMethodReported = true;
            // Fixed message so every report dedupes into one remote issue —
            // reportIssue() dedupes by exact message string, and a
            // per-model/firmware message here would instead spawn a brand new,
            // permanent issue for every device variant across all users (it did:
            // dozens of "Auth method: ..." issues appeared within minutes of
            // shipping this). The variant data goes in `extra` and is visible
            // per-event in Better Stack without multiplying the issue list.
            const authPreferences = this.api.getAuthPreferences();
            (this.homey.app as any).reportIssue?.(
              'Auth method reported',
              {
                contentType: authPreferences.contentType,
                bodyFormat: authPreferences.bodyFormat,
                model: device.device_model,
                hardware_ver: device.hardware_ver,
                software_ver: device.software_ver,
              },
            );
          }

          // Update device settings with retrieved information
          await this.updateSettingsIfChanged({
            hardware_ver: device.hardware_ver,
            software_ver: device.software_ver,
            role: device.role,
            ip: device.device_ip,
          });

          await this.updateCapability(
            'alarm_group_state',
            device.group_status.toLowerCase() !== 'connected',
          );
          await this.updateCapability('device_role', device.role);
          await this.updateCapability('lan_ipv4_ipaddr', device.device_ip || settings.ip || settings.hostname);

          // Signal strength and backhaul are only meaningful on satellite nodes.
          // Dynamically add/remove so they never appear on the master tile.
          const isMaster = device.role.toLowerCase() === 'master';
          if (!this.apiRoleReported) {
            this.apiRoleReported = true;
            this.log(`Resolved mesh role from API: ${device.role}`);
          }
          if (this.configuredAsMaster !== isMaster) {
            await this.syncRoleCapabilities(isMaster);
          }
          if (!isMaster) {
            const diagnostic = buildBackhaulDiagnostic(device);
            await this.updateCapability('signal_strength_2g', diagnostic.signal2g);
            await this.updateCapability('signal_strength_5g', diagnostic.signal5g);
            await this.updateCapability('signal_strength_6g', diagnostic.signal6g);
            await this.updateCapability('backhaul_connection', diagnostic.connection);
            const parent = deviceList.result.device_list.find((candidate) => (
              candidate.device_id === device.parent_device_id
              || candidate.mac === device.parent_device_id
            )) ?? deviceList.result.device_list.find(
              (candidate) => candidate.role.toLowerCase() === 'master',
            );
            const parentName = parent
              ? (this.driver as TplinkDecoDriver).resolveNickname(parent)
              : '';
            await this.updateCapability(
              'backhaul_parent',
              parent ? `${parent.device_model}${parentName ? ` - ${parentName}` : ''}` : '–',
            );
            await this.updateCapability('alarm_backhaul_degraded', diagnostic.degraded);
            if (
              this.savedBackhaulDegraded !== undefined
              && this.savedBackhaulDegraded !== diagnostic.degraded
            ) {
              const backhaulFlow = this.homey.flow.getDeviceTriggerCard('backhaul_health_changed');
              await backhaulFlow.trigger(this, {
                degraded: diagnostic.degraded,
                reason: diagnostic.reason,
                connection: diagnostic.connection,
                signal_2g: diagnostic.signal2g,
                signal_5g: diagnostic.signal5g,
                signal_6g: diagnostic.signal6g,
              });
            }
            this.savedBackhaulDegraded = diagnostic.degraded;
          }

          // Fetch performance metrics — only available on master node
          let resultCpuUsage: number | null = null;
          let resultMemUsage: number | null = null;
          if (poll.performance?.error_code === 0 && poll.performance.result) {
              resultCpuUsage = Math.round(Number(poll.performance.result.cpu_usage) * 100);
              resultMemUsage = Math.round(Number(poll.performance.result.mem_usage) * 100);
              await this.updateCapability('measure_cpu_usage', resultCpuUsage);
              await this.updateCapability('measure_mem_usage', resultMemUsage);
          }

          if (isMaster && this.masterFeatureCoordinator) {
            await this.masterFeatureCoordinator.poll(devicedata.id);
          }

          // Fetch WAN IP address
          if (isMaster) {
            const wanResponse = poll.wan;
            if (wanResponse?.error_code === 0) {
              const wanIpAddress = wanResponse.result?.wan?.ip_info?.ip ?? '';
              await this.updateCapability('wan_ipv4_ipaddr', wanIpAddress);
              const uptime = wanResponse.result?.wan?.uptime
                ?? wanResponse.result?.wan?.ip_info?.uptime;
              if (uptime === undefined || uptime === null) {
                if (this.hasCapability('wan_ipv4_uptime')) {
                  await this.removeCapability('wan_ipv4_uptime');
                }
              } else {
                if (!this.hasCapability('wan_ipv4_uptime')) {
                  await this.addCapability('wan_ipv4_uptime');
                }
                await this.updateCapability('wan_ipv4_uptime', formatUptime(uptime));
              }
            }
          }
          // Fetch Internet status — only available on master node
          if (isMaster) {
            const internetResponse = poll.internet;

            // Only update WAN alarm when we got a real response (not the safeApiCall fallback).
            // If the call failed/timed-out, error_code is 1 (our default) and we leave
            // the capability at its last known value to avoid false "disconnected" alerts.
            if (internetResponse?.error_code === 0) {
              // Cellular models (IMEI present, e.g. X50-5G) connect to the internet via
              // 5G — the wired WAN port is unused so internet.ipv4.inet_status is empty /
              // disconnected even when online.  device_list.inet_status is the reliable
              // source for actual internet connectivity on these models.
              const ipv4InetStatus = device.imei
                ? device.inet_status
                : (internetResponse?.result?.ipv4?.inet_status ?? '');
              await this.handleWanStateChange(
                'ipv4',
                ipv4InetStatus,
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

          if (!poll.clientsAvailable) {
            this.log('Client list unavailable; preserving the previous client and presence state');
            await this.markPollSuccessful();
            return;
          }
          const clientList = poll.clients;

          // Feed this node's own client list into the driver's shared cache so the
          // master can build a mesh-wide view without a separate API call. This
          // replaces the old device_mac: 'default' request,
          // which returned error_code=1 across ~14 models in our field telemetry).
          if (devicedata.id) {
            (this.driver as TplinkDecoDriver).setNodeClientList(settings.hostname, devicedata.id, clientList);
          }

          const clientNames = clientList
            .map((client) => (this.driver as TplinkDecoDriver).decodeNickname(client.name))
            .join(', ');
          await this.updateSettingsIfChanged({ clients: clientNames });
          // Update capability with the number of connected clients
          await this.updateCapability('connected_clients', clientList.length);
          const interfaceCounts = { guest: 0, iot: 0, mlo: 0 };
          for (const client of clientList) {
            if (Object.hasOwn(interfaceCounts, client.interface)) {
              interfaceCounts[client.interface as keyof typeof interfaceCounts] += 1;
            }
          }
          await this.updateCapability('connected_clients_guest', interfaceCounts.guest);
          await this.updateCapability('connected_clients_iot', interfaceCounts.iot);
          await this.updateCapability('connected_clients_mlo', interfaceCounts.mlo);

          // Build a MAC → friendly-name map for the Deco nodes so the
          // client_node_changed token shows a human-readable name.
          const decoNodeNames = new Map<string, string>();
          for (const d of deviceList.result.device_list) {
            const nick = (this.driver as TplinkDecoDriver).resolveNickname(d);
            const displayName = nick ? `${d.device_model} - ${nick}` : (d.device_model || d.mac);
            for (const identifier of [d.mac, d.device_id]) {
              if (identifier) decoNodeNames.set(identifier.toUpperCase(), displayName);
            }
          }

          // Handle client state changes
          await this.handleClientStateChanges(clientList, decoNodeNames);

          // Mesh-wide presence — master only. Previously fetched via a dedicated
          // device_mac: 'default' request, which returned error_code=1 across a
          // dozen+ models in our field telemetry (other Deco integrations document
          // 'default' as supported, so this may be firmware/model-specific rather
          // than universally invalid — see TplinkDecoDriver.meshClientCache for
          // details). Build the mesh-wide view instead from the per-node client
          // lists every device already fetches for itself above (device_mac: <own
          // MAC>, confirmed working everywhere) — no extra API call needed either way.
          if (isMaster) {
            const maxMeshAgeMs = Math.max(
              normalizePollIntervalSeconds(settings.timeoutSeconds) * 3000,
              120000,
            );
            const meshSnapshot = (this.driver as TplinkDecoDriver)
              .getMeshClientSnapshot(settings.hostname, maxMeshAgeMs);
            this.log(
              `Mesh-wide client snapshot: clients=${meshSnapshot.clients.length} `
              + `(polled nodes=${meshSnapshot.nodeCount}, discovered nodes=${deviceList.result.device_list.length})`,
            );
            await this.handleMeshPresence(meshSnapshot.clients, decoNodeNames);
            await this.updateCapability(
              'prioritized_clients',
              countPrioritizedClients(meshSnapshot.clients),
            );
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
          if (resultCpuUsage !== null && resultMemUsage !== null) {
            await this.triggerUsageFlowCards(
              resultCpuUsage,
              resultMemUsage,
              settings.hostname,
            );
          }

          // LTE data usage — auto-detected: capabilities are added/removed based on API response
          await this.updateLteMetrics(device.imei);
          await this.markPollSuccessful();
        } else {
          this.error(`Paired Deco ${devicedata.id} was not present in device_list`);
          await this.markPollFailed();
        }
      } else {
        this.error('Deco returned an empty device_list');
        await this.markPollFailed();
      }
    } catch (error) {
      this.error('Failed to update device metrics', error);
      await this.markPollFailed();
    }
  }

  private async markPollSuccessful(): Promise<void> {
    this.connected = true;
    if (this.consecutivePollFailures > 0) {
      this.log(`Device metrics recovered after ${this.consecutivePollFailures} failed poll(s)`);
      await this.setAvailable().catch((error) => this.error('Failed to mark device available', error));
    }
    this.consecutivePollFailures = 0;
  }

  private async markPollFailed(): Promise<void> {
    this.consecutivePollFailures += 1;
    if (this.consecutivePollFailures < 3) return;

    this.connected = false;
    await this.setUnavailable(
      `Unable to refresh TP-Link Deco after ${this.consecutivePollFailures} attempts`,
    ).catch((error) => this.error('Failed to mark device unavailable', error));
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

  private async handleClientStateChanges(
    clientList: DecoClient[],
    decoNodeNames: Map<string, string> = new Map(),
  ): Promise<void> {
    try {
      const result = reconcileNodeClients({
        tracked: this.trackedClients,
        previousClients: this.clients,
        clients: clientList,
        nodeNames: decoNodeNames,
        decodeName: (name) => (this.driver as TplinkDecoDriver).decodeNickname(name),
      });
      this.trackedClients = result.tracked;
      this.clients = result.currentClients;
      const now = Date.now();
      if (
        result.events.length > 0
        || now - this.lastTrackedClientsPersistAt >= PERSISTENCE_CHECKPOINT_INTERVAL_MS
      ) {
        await this.setStoreValue('trackedClients', this.trackedClients);
        this.lastTrackedClientsPersistAt = now;
      }
      await this.emitNodeClientEvents(result.events);
    } catch (error) {
      this.error('Failed to handle client state changes', error);
    }
  }

  private async emitNodeClientEvents(events: NodeClientEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === 'state') {
        await this.homey.flow.getDeviceTriggerCard('client_state_changed').trigger(
          this,
          event.tokens,
          { status: event.status, client: event.tokens },
        );
        await this.homey.flow.getDeviceTriggerCard('any_client_state_changed').trigger(
          this,
          { ...event.tokens, status: event.status },
          { status: event.status },
        );
        continue;
      }
      if (event.type === 'first-seen') {
        await this.homey.flow.getDeviceTriggerCard('client_first_seen').trigger(this, event.tokens);
        continue;
      }
      if (event.type === 'node-changed') {
        await this.homey.flow.getDeviceTriggerCard('client_node_changed').trigger(
          this,
          {
            name: event.name,
            mac: event.mac,
            deco_node: event.node,
            previous_node: event.previousNode,
          },
          { mac: event.mac },
        );
        continue;
      }
      await this.homey.flow.getDeviceTriggerCard('client_priority_changed').trigger(
        this,
        {
          name: event.name,
          mac: event.mac,
          prioritized: event.prioritized,
          priority_remaining_seconds: event.remainingSeconds,
        },
        { mac: event.mac, prioritized: event.prioritized },
      );
    }
  }

  private async handleMeshPresence(
    meshClientList: DecoClient[],
    decoNodeNames: Map<string, string> = new Map(),
  ): Promise<void> {
    try {
      const result = reconcileMeshClients({
        tracked: this.meshTrackedClients,
        clients: meshClientList,
        nodeNames: decoNodeNames,
        decodeName: (name) => (this.driver as TplinkDecoDriver).decodeNickname(name),
      });
      this.meshTrackedClients = result.tracked;
      const now = Date.now();
      if (
        result.events.length > 0
        || now - this.lastMeshClientsPersistAt >= PERSISTENCE_CHECKPOINT_INTERVAL_MS
      ) {
        await this.setStoreValue('meshTrackedClients', this.meshTrackedClients);
        this.lastMeshClientsPersistAt = now;
      }
      await this.emitMeshClientEvents(result.events);
    } catch (error) {
      this.error('Failed to handle mesh presence', error);
    }
  }

  private async emitMeshClientEvents(events: MeshClientEvent[]): Promise<void> {
    for (const event of events) {
      if (event.type === 'joined') {
        await this.homey.flow.getTriggerCard('client_joined_mesh').trigger(
          {
            name: event.name,
            ipaddr: event.ipaddr,
            mac: event.mac,
            connection_type: event.connectionType,
            deco_node: event.node,
          },
          { mac: event.mac },
        );
        continue;
      }
      await this.homey.flow.getTriggerCard('client_left_mesh').trigger(
        { name: event.name, ipaddr: event.ipaddr, mac: event.mac },
        { mac: event.mac },
      );
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

    const hasData = (r: { error_code: number; result: any } | null) =>
      r?.error_code === 0 && r.result != null && Object.keys(r.result).length > 0;

    // Fast path: already confirmed this device has no cellular API
    if (this.lteFormCache === null) {
      await removeCaps();
      return;
    }

    let intfCfg: LteIntfCfgResponse | null;
    let linkCfg: LteLinkCfgResponse | null;

    if (this.lteFormCache === undefined) {
      // --- First call: probe which endpoint family works ---
      // Always try 'lte' first (works for all 4G models).
      // On cellular models (IMEI present), also probe '5g' and 'nr' (5G NR).
      const probePrefixes = imei ? ['lte', '5g', 'nr'] : ['lte'];
      let detectedIntfCfg: LteIntfCfgResponse | undefined;
      let receivedProbeResponse = false;

      for (const prefix of probePrefixes) {
        // silent=true: 2 of 3 prefixes failing with "no such callback" is the
        // expected outcome here (a model only supports one of lte/5g/nr, if
        // any) — not worth logging as an error on every poll cycle.
        const probe = await tryApiCall<LteIntfCfgResponse>(
          () => this.api.custom<LteIntfCfgResponse>('/admin/network', { form: `${prefix}_intf_cfg` }, this.readBody, true),
          (error) => this.error(`Failed to retrieve ${prefix}_intf_cfg probe`, error),
        );
        if (probe) receivedProbeResponse = true;
        if (probe && hasData(probe)) {
          this.lteFormCache = prefix;
          this.log(`updateLteMetrics: ${prefix}_intf_cfg works — caching cellular endpoint as "${prefix}"`);
          detectedIntfCfg = probe;
          break;
        }
      }

      if (!detectedIntfCfg) {
        if (!receivedProbeResponse) return;
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
      linkCfg = await tryApiCall<LteLinkCfgResponse>(
        () => this.api.custom<LteLinkCfgResponse>('/admin/network', { form: linkForm }, this.readBody),
        (error) => this.error(`Failed to retrieve ${linkForm}`, error),
      );
    } else {
      // --- Subsequent calls: use cached form directly ---
      const prefix = this.lteFormCache as string;
      const intfForm = `${prefix}_intf_cfg`;
      const linkForm = `${prefix}_link_cfg`;

      intfCfg = await tryApiCall<LteIntfCfgResponse>(
        () => this.api.custom<LteIntfCfgResponse>('/admin/network', { form: intfForm }, this.readBody),
        (error) => this.error(`Failed to retrieve ${intfForm}`, error),
      );
      linkCfg = await tryApiCall<LteLinkCfgResponse>(
        () => this.api.custom<LteLinkCfgResponse>('/admin/network', { form: linkForm }, this.readBody),
        (error) => this.error(`Failed to retrieve ${linkForm}`, error),
      );

      if (!hasData(intfCfg)) {
        // Endpoint stopped responding — reset cache so next poll re-probes
        this.lteFormCache = undefined;
        await removeCaps();
        return;
      }
    }

    if (!intfCfg || !linkCfg) return;

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
   * Updates a device capability with the provided value.
   * @param capability - The name of the capability to update.
   * @param value - The value to set for the capability.
   */
  private async updateCapability(capability: string, value: any) {
    try {
      if (!this.hasCapability(capability)) return;
      const currentValue = this.getCapabilityValue(capability);
      if (currentValue !== value) {
        await this.setCapabilityValue(capability, value);
      }
    } catch (err) {
      this.error(`Failed to update capability ${capability}`, err);
    }
  }

  private async updateSettingsIfChanged(updates: Record<string, unknown>): Promise<void> {
    const current = this.getSettings();
    const changed = Object.fromEntries(
      Object.entries(updates).filter(([key, value]) => current[key] !== value),
    );
    if (Object.keys(changed).length === 0) return;
    await this.setSettings(changed);
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
