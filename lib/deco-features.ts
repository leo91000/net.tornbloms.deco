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

export type RadioFeature = 'fastRoaming' | 'beamforming';

export interface RadioFeatureSnapshot {
  supported: boolean;
  enabled: boolean;
}

export interface SpeedTestSnapshot {
  supported: boolean;
  status: string;
  downMbps: number;
  upMbps: number;
  pingMs: number;
  jitterMs: number;
  lastRunAt: string;
}

interface CustomApi {
  custom<T = unknown>(
    path: string,
    params: { form: string },
    body: Buffer,
    isLogin?: boolean,
  ): Promise<T>;
}

type JsonObject = Record<string, unknown>;

interface ClientAccessRequest {
  path: '/admin/client';
  form: 'block' | 'unblock';
  body: {
    operation: 'write';
    params: { mac: string };
  };
}

const radioFeatureForms: Record<RadioFeature, string> = {
  fastRoaming: 'ieee80211r',
  beamforming: 'beamforming',
};

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

function asObject(value: unknown): JsonObject | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as JsonObject;
}

function getResult(response: unknown): JsonObject {
  const envelope = asObject(response);
  const result = asObject(envelope?.result);
  if (envelope?.error_code !== 0 || !result) {
    throw new Error(`Deco feature request failed (${envelope?.error_code ?? 'invalid response'})`);
  }
  return result;
}

function assertWriteSucceeded(response: unknown): void {
  const envelope = asObject(response);
  if (envelope?.error_code === 0 || envelope?.success === true) return;
  throw new Error(`Deco rejected the requested change (${envelope?.error_code ?? envelope?.errorcode ?? 'invalid response'})`);
}

export function buildRadioFeatureSnapshot(response: unknown): RadioFeatureSnapshot {
  const envelope = asObject(response);
  const result = asObject(envelope?.result);
  if (envelope?.error_code !== 0 || typeof result?.enable !== 'boolean') {
    return { supported: false, enabled: false };
  }
  return { supported: true, enabled: result.enable };
}

export function buildSpeedTestSnapshot(response: unknown): SpeedTestSnapshot {
  const envelope = asObject(response);
  const result = asObject(envelope?.result);
  if (envelope?.error_code !== 0 || !result) {
    return {
      supported: false,
      status: 'unsupported',
      downMbps: 0,
      upMbps: 0,
      pingMs: 0,
      jitterMs: 0,
      lastRunAt: '',
    };
  }

  const lastRunSeconds = Number(result.last_speed_test_time);
  return {
    supported: true,
    status: typeof result.status === 'string' ? result.status : 'unknown',
    // Deco reports these values in Kbit/s: 2,235,395 means 2,235.395 Mbit/s.
    downMbps: Math.round((Number(result.down_speed) || 0) / 1000),
    upMbps: Math.round((Number(result.up_speed) || 0) / 1000),
    pingMs: Math.round((Number(result.ping_time) || 0) * 10) / 10,
    jitterMs: Math.round((Number(result.ping_jitter) || 0) * 10) / 10,
    lastRunAt: Number.isFinite(lastRunSeconds) && lastRunSeconds > 0
      ? new Date(lastRunSeconds * 1000).toISOString()
      : '',
  };
}

export function buildSpeedTestStartParams(value: unknown): Record<string, unknown> {
  const result = asObject(value);
  const selectedServerIds = Array.isArray(result?.select_server_id_list)
    ? result.select_server_id_list.filter((serverId: unknown) => typeof serverId === 'string')
    : [];
  const availableServers = [
    ...(Array.isArray(result?.single_server_list) ? result.single_server_list : []),
    ...(Array.isArray(result?.multi_server_list) ? result.multi_server_list : []),
  ];
  const fallbackServer = availableServers
    .map((server) => asObject(server))
    .find((server) => typeof server?.server_id === 'string');
  const fallbackServerId = fallbackServer?.server_id as string | undefined;
  const serverIds = selectedServerIds.length > 0
    ? selectedServerIds
    : (fallbackServerId ? [fallbackServerId] : []);
  if (serverIds.length === 0) {
    throw new Error('The Deco did not return an available speed-test server.');
  }

  return {
    type: result?.type === 'multi' ? 'multi' : 'single',
    is_auto: result?.is_auto !== false,
    select_server_id_list: serverIds,
  };
}

export function buildWirelessSnapshot(value: unknown): WirelessSnapshot {
  const wireless = asObject(value);
  const supportedBands: string[] = [];
  let mainSsid = '';
  let guestSsid = '';
  let guestEnabled = false;
  let guestSupported = false;

  for (const [key, label] of bandLabels) {
    const band = asObject(wireless?.[key]);
    if (!band) continue;
    supportedBands.push(label);
    const host = asObject(band.host);
    const guest = asObject(band.guest);
    if (!mainSsid) mainSsid = decodeBase64(host?.ssid);
    if (guest) {
      guestSupported = true;
      if (!guestSsid) guestSsid = decodeBase64(guest.ssid);
      guestEnabled ||= guest.enable === true;
    }
  }

  const iotHost = asObject(asObject(wireless?.iot)?.host);
  const mloHost = asObject(asObject(wireless?.mlo)?.host);
  const iotSupported = iotHost !== undefined;
  const mloSupported = mloHost !== undefined;

  return {
    mainSsid,
    guestSsid,
    guestEnabled,
    iotSsid: decodeBase64(iotHost?.ssid),
    iotEnabled: iotHost?.enable === true,
    mloSsid: decodeBase64(mloHost?.ssid),
    mloEnabled: mloHost?.enable === true,
    supportedBands,
    guestSupported,
    iotSupported,
    mloSupported,
  };
}

export function buildWirelessToggleRequest(
  value: unknown,
  kind: WirelessNetworkKind,
  enabled: boolean,
): { operation: 'write'; params: Record<string, unknown> } {
  const wireless = asObject(value);
  if (kind === 'guest') {
    const params: Record<string, unknown> = {};
    for (const [key] of bandLabels) {
      if (!asObject(asObject(wireless?.[key])?.guest)) continue;
      params[key] = { guest: { enable: enabled } };
    }
    if (Object.keys(params).length === 0) {
      throw new Error('Guest Wi-Fi is not supported by this Deco firmware.');
    }
    return { operation: 'write', params };
  }

  if (kind === 'iot' && asObject(asObject(wireless?.iot)?.host)) {
    return { operation: 'write', params: { iot: { host: { enable: enabled } } } };
  }

  if (kind === 'mlo' && asObject(asObject(wireless?.mlo)?.host)) {
    return { operation: 'write', params: { mlo: { host: { enable: enabled } } } };
  }

  throw new Error(`Unsupported wireless network: ${kind}`);
}

function applyWirelessEnabled(
  wireless: JsonObject,
  kind: WirelessNetworkKind,
  enabled: boolean,
): JsonObject {
  const updated: JsonObject = { ...wireless };
  if (kind === 'guest') {
    for (const [key] of bandLabels) {
      const band = asObject(wireless[key]);
      const guest = asObject(band?.guest);
      if (!band || !guest) continue;
      updated[key] = { ...band, guest: { ...guest, enable: enabled } };
    }
    return updated;
  }

  const network = asObject(wireless[kind]);
  const host = asObject(network?.host);
  if (!network || !host) return updated;
  updated[kind] = { ...network, host: { ...host, enable: enabled } };
  return updated;
}

export function buildClientAccessRequest(mac: string, allowed: boolean): ClientAccessRequest {
  const normalizedMac = normalizeClientMac(mac);

  return {
    path: '/admin/client',
    form: allowed ? 'unblock' : 'block',
    body: { operation: 'write', params: { mac: normalizedMac } },
  };
}

export function findFirmwareUpdate(value: unknown, mac: string): FirmwareUpdateSnapshot {
  const result = asObject(value);
  const normalizedMac = mac.replace(/:/g, '-').toUpperCase();
  const updates = Array.isArray(result?.fw_list) ? result.fw_list : [];
  const update = updates
    .map((entry) => asObject(entry))
    .find((entry) => (
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
    return buildWirelessSnapshot(applyWirelessEnabled(wireless, kind, enabled));
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

  async readRadioFeature(feature: RadioFeature): Promise<RadioFeatureSnapshot> {
    const response = await this.api.custom(
      '/admin/wireless',
      { form: radioFeatureForms[feature] },
      Buffer.from('{"operation":"read"}'),
    );
    return buildRadioFeatureSnapshot(response);
  }

  async setRadioFeature(feature: RadioFeature, enabled: boolean): Promise<RadioFeatureSnapshot> {
    const current = await this.readRadioFeature(feature);
    if (!current.supported) {
      throw new Error(`${feature} is not supported by this Deco firmware.`);
    }
    const response = await this.api.custom(
      '/admin/wireless',
      { form: radioFeatureForms[feature] },
      Buffer.from(JSON.stringify({ operation: 'write', params: { enable: enabled } })),
    );
    assertWriteSucceeded(response);
    return { supported: true, enabled };
  }

  async readSpeedTest(): Promise<SpeedTestSnapshot> {
    const response = await this.api.custom(
      '/admin/device',
      { form: 'speedtest' },
      Buffer.from('{"operation":"read"}'),
    );
    return buildSpeedTestSnapshot(response);
  }

  async startSpeedTest(): Promise<void> {
    const serverResponse = await this.api.custom(
      '/admin/device',
      { form: 'speedtest' },
      Buffer.from('{"operation":"get_server"}'),
    );
    const params = buildSpeedTestStartParams(getResult(serverResponse));
    const response = await this.api.custom(
      '/admin/device',
      { form: 'speedtest' },
      Buffer.from(JSON.stringify({ operation: 'write', params })),
    );
    assertWriteSucceeded(response);
  }
}
