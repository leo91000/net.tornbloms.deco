'use strict';
import crypto from 'crypto';
import { Driver } from 'homey';
import decoapiwrapper, { AppLogger, DeviceListResponse } from '../../lib/client';

class TplinkDecoDriver extends Driver {
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  private api: decoapiwrapper | any;

  // Buffer for read operations
  readBody = Buffer.from('{"operation": "read"}');

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
              hostname: hostname,
              password: password,
              model: device.device_model,
              ip: device.device_ip,
              role: device.role,
              hardware_ver: device.hardware_ver,
              software_ver: device.software_ver,
              hw_id: device.hw_id,
              timeoutSeconds: 10,
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

module.exports = TplinkDecoDriver;
