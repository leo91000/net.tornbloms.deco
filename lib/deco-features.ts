import { normalizeClientMac } from './advanced-controls';

export type WirelessNetworkKind = 'guest' | 'iot' | 'mlo';

export interface WirelessSnapshot {
  mainSsid: string;
  guestSsid: string;
  guestEnabled: boolean;
  iotSsid: string;
  iotEnabled: boolean;
  mloSsid: string;
  mloEnabled: boolean;
  supportedBands: string[];
  guestSupported: boolean;
  iotSupported: boolean;
  mloSupported: boolean;
}

export interface FirmwareUpdateSnapshot {
  available: boolean;
  version: string;
}

interface CustomApi {
  custom(
    path: string,
    params: { form: string },
    body: Buffer,
    isLogin?: boolean,
  ): Promise<any>;
}

interface ClientAccessRequest {
  path: '/admin/client';
  form: 'block' | 'unblock';
  body: {
    operation: 'write';
    params: { mac: string };
  };
}

const bandLabels: Array<[string, string]> = [
  ['band2_4', '2.4 GHz'],
  ['band5_1', '5 GHz'],
  ['band5_2', '5 GHz (2)'],
  ['band6', '6 GHz'],
  ['band6_2', '6 GHz (2)'],
];

function decodeBase64(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    const normalizedInput = value.replace(/=+$/, '');
    const normalizedRoundTrip = Buffer.from(decoded).toString('base64').replace(/=+$/, '');
    return normalizedRoundTrip === normalizedInput ? decoded : value;
  } catch {
    return value;
  }
}

function getResult(response: any): any {
  if (!response || response.error_code !== 0 || !response.result) {
    throw new Error(`Deco feature request failed (${response?.error_code ?? 'invalid response'})`);
  }
  return response.result;
}

function assertWriteSucceeded(response: any): void {
  if (response?.error_code === 0 || response?.success === true) return;
  throw new Error(`Deco rejected the requested change (${response?.error_code ?? response?.errorcode ?? 'invalid response'})`);
}

export function buildWirelessSnapshot(wireless: any): WirelessSnapshot {
  const supportedBands: string[] = [];
  let mainSsid = '';
  let guestSsid = '';
  let guestEnabled = false;
  let guestSupported = false;

  for (const [key, label] of bandLabels) {
    const band = wireless?.[key];
    if (!band) continue;
    supportedBands.push(label);
    if (!mainSsid) mainSsid = decodeBase64(band.host?.ssid);
    if (band.guest) {
      guestSupported = true;
      if (!guestSsid) guestSsid = decodeBase64(band.guest.ssid);
      guestEnabled ||= band.guest.enable === true;
    }
  }

  const iotSupported = wireless?.iot?.host !== undefined;
  const mloSupported = wireless?.mlo?.host !== undefined;

  return {
    mainSsid,
    guestSsid,
    guestEnabled,
    iotSsid: decodeBase64(wireless?.iot?.host?.ssid),
    iotEnabled: wireless?.iot?.host?.enable === true,
    mloSsid: decodeBase64(wireless?.mlo?.host?.ssid),
    mloEnabled: wireless?.mlo?.host?.enable === true,
    supportedBands,
    guestSupported,
    iotSupported,
    mloSupported,
  };
}

export function buildWirelessToggleRequest(
  wireless: any,
  kind: WirelessNetworkKind,
  enabled: boolean,
): { operation: 'write'; params: Record<string, unknown> } {
  if (kind === 'guest') {
    const params: Record<string, unknown> = {};
    for (const [key] of bandLabels) {
      if (!wireless?.[key]?.guest) continue;
      params[key] = { guest: { enable: enabled } };
    }
    if (Object.keys(params).length === 0) {
      throw new Error('Guest Wi-Fi is not supported by this Deco firmware.');
    }
    return { operation: 'write', params };
  }

  if (kind === 'iot' && wireless?.iot?.host) {
    return { operation: 'write', params: { iot: { host: { enable: enabled } } } };
  }

  if (kind === 'mlo' && wireless?.mlo?.host) {
    return { operation: 'write', params: { mlo: { host: { enable: enabled } } } };
  }

  throw new Error(`Unsupported wireless network: ${kind}`);
}

export function buildClientAccessRequest(mac: string, allowed: boolean): ClientAccessRequest {
  const normalizedMac = normalizeClientMac(mac);

  return {
    path: '/admin/client',
    form: allowed ? 'unblock' : 'block',
    body: { operation: 'write', params: { mac: normalizedMac } },
  };
}

export function findFirmwareUpdate(result: any, mac: string): FirmwareUpdateSnapshot {
  const normalizedMac = mac.replace(/:/g, '-').toUpperCase();
  const updates = Array.isArray(result?.fw_list) ? result.fw_list : [];
  const update = updates.find((entry: any) => (
    typeof entry?.mac === 'string'
    && entry.mac.replace(/:/g, '-').toUpperCase() === normalizedMac
  ));
  if (!update) return { available: false, version: '' };
  return {
    available: update.need_to_upgrade === true,
    version: typeof update.new_version === 'string' ? decodeBase64(update.new_version) : '',
  };
}

export class DecoFeatureController {
  constructor(private readonly api: CustomApi) {}

  async readWireless(): Promise<WirelessSnapshot> {
    const response = await this.api.custom(
      '/admin/wireless',
      { form: 'wlan' },
      Buffer.from('{"operation":"read"}'),
    );
    return buildWirelessSnapshot(getResult(response));
  }

  async setWirelessEnabled(kind: WirelessNetworkKind, enabled: boolean): Promise<WirelessSnapshot> {
    const readResponse = await this.api.custom(
      '/admin/wireless',
      { form: 'wlan' },
      Buffer.from('{"operation":"read"}'),
    );
    const wireless = getResult(readResponse);
    const request = buildWirelessToggleRequest(wireless, kind, enabled);
    const writeResponse = await this.api.custom(
      '/admin/wireless',
      { form: 'wlan' },
      Buffer.from(JSON.stringify(request)),
    );
    assertWriteSucceeded(writeResponse);
    return buildWirelessSnapshot({
      ...wireless,
      ...(kind === 'iot' ? { iot: { ...wireless.iot, host: { ...wireless.iot.host, enable: enabled } } } : {}),
      ...(kind === 'mlo' ? { mlo: { ...wireless.mlo, host: { ...wireless.mlo.host, enable: enabled } } } : {}),
      ...(kind === 'guest'
        ? Object.fromEntries(bandLabels
          .filter(([key]) => wireless[key]?.guest)
          .map(([key]) => [key, {
            ...wireless[key],
            guest: { ...wireless[key].guest, enable: enabled },
          }]))
        : {}),
    });
  }

  async setClientAccess(mac: string, allowed: boolean): Promise<void> {
    const request = buildClientAccessRequest(mac, allowed);
    const response = await this.api.custom(
      request.path,
      { form: request.form },
      Buffer.from(JSON.stringify(request.body)),
    );
    assertWriteSucceeded(response);
  }

  async checkFirmwareUpdate(mac: string): Promise<FirmwareUpdateSnapshot> {
    const response = await this.api.custom(
      '/admin/cloud',
      { form: 'firmware_status' },
      Buffer.from('{"operation":"check"}'),
    );
    return findFirmwareUpdate(getResult(response), mac);
  }
}
