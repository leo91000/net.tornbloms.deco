export const MIN_PAUSE_MINUTES = 1;
export const MAX_PAUSE_MINUTES = 7 * 24 * 60;

export interface BackhaulDiagnostic {
  connection: string;
  degraded: boolean;
  reason: string;
  signal2g: string;
  signal5g: string;
  signal6g: string;
}

const signalLabels: Record<string, string> = {
  '1': 'Weak',
  '2': 'Good',
  '3': 'Strong',
  '4': 'Strong',
};

export function normalizeClientMac(mac: string): string {
  const normalizedMac = mac.trim().toUpperCase().replace(/:/g, '-');
  if (!/^[0-9A-F]{2}(?:-[0-9A-F]{2}){5}$/.test(normalizedMac)) {
    throw new Error('Invalid client MAC address.');
  }
  return normalizedMac;
}

export function normalizePauseDurationMinutes(value: unknown): number {
  const duration = Number(value);
  if (!Number.isInteger(duration)) {
    throw new Error('Pause duration must be a whole number of minutes.');
  }
  if (duration < MIN_PAUSE_MINUTES || duration > MAX_PAUSE_MINUTES) {
    throw new Error(`Pause duration must be between ${MIN_PAUSE_MINUTES} and ${MAX_PAUSE_MINUTES} minutes.`);
  }
  return duration;
}

export function countPrioritizedClients(clients: any[]): number {
  return clients.reduce(
    (count, client) => count + (client?.enable_priority === true ? 1 : 0),
    0,
  );
}

export function buildBackhaulDiagnostic(device: any): BackhaulDiagnostic {
  const rawConnections = Array.isArray(device?.connection_type)
    ? device.connection_type.filter((value: unknown) => typeof value === 'string')
    : [];
  const connection = rawConnections.length === 0
    ? '–'
    : rawConnections.map((type: string) => {
      if (type === 'wired') return 'Wired';
      if (type === 'band2_4') return 'WiFi 2.4 GHz';
      if (type === 'band5') return 'WiFi 5 GHz';
      if (type === 'band5_2') return 'WiFi 5 GHz (2)';
      if (type === 'band6') return 'WiFi 6 GHz';
      if (type === 'band6_2') return 'WiFi 6 GHz (2)';
      return type;
    }).join(' + ');

  const signal2g = signalLabels[device?.signal_level?.band2_4] ?? device?.signal_level?.band2_4 ?? '–';
  const signal5g = signalLabels[device?.signal_level?.band5] ?? device?.signal_level?.band5 ?? '–';
  const signal6g = signalLabels[device?.signal_level?.band6] ?? device?.signal_level?.band6 ?? '–';
  const disconnected = typeof device?.group_status === 'string'
    && device.group_status.toLowerCase() !== 'connected';

  if (disconnected) {
    return {
      connection,
      degraded: true,
      reason: 'Disconnected from mesh',
      signal2g,
      signal5g,
      signal6g,
    };
  }

  if (rawConnections.includes('wired')) {
    return {
      connection,
      degraded: false,
      reason: '',
      signal2g,
      signal5g,
      signal6g,
    };
  }

  const activeWirelessSignals = [
    rawConnections.includes('band2_4') ? device?.signal_level?.band2_4 : undefined,
    rawConnections.some((type: string) => type === 'band5' || type === 'band5_2')
      ? device?.signal_level?.band5
      : undefined,
    rawConnections.some((type: string) => type === 'band6' || type === 'band6_2')
      ? device?.signal_level?.band6
      : undefined,
  ].filter((value) => value !== undefined && value !== null && value !== '');
  const weakWirelessBackhaul = activeWirelessSignals.length > 0
    && activeWirelessSignals.every((value) => Number(value) <= 1);

  return {
    connection,
    degraded: weakWirelessBackhaul,
    reason: weakWirelessBackhaul ? 'Weak wireless backhaul' : '',
    signal2g,
    signal5g,
    signal6g,
  };
}
