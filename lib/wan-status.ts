export interface WanStatusSources {
  nodeInternetStatus?: string;
  wanInternetStatus?: string;
  wanIpAddress?: string;
}

function parseDisconnected(status: string | undefined): boolean | undefined {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (['online', 'connected', 'up'].includes(normalized)) return false;
  if (['offline', 'disconnected', 'down'].includes(normalized)) return true;
  return undefined;
}

export function resolveWanDisconnected({
  nodeInternetStatus,
  wanInternetStatus,
  wanIpAddress,
}: WanStatusSources): boolean | undefined {
  const nodeDisconnected = parseDisconnected(nodeInternetStatus);
  const wanDisconnected = parseDisconnected(wanInternetStatus);
  const hasWanIpAddress = Boolean(wanIpAddress?.trim());

  if (hasWanIpAddress) return wanDisconnected ?? nodeDisconnected;
  return nodeDisconnected ?? wanDisconnected;
}
