export type WanIpVersion = 'ipv4' | 'ipv6';

export interface WanFlowEvent {
  cardId: 'alarm_wan_state_changed' | 'alarm_wan_state_true' | 'alarm_wan_state_false';
  tokens: {
    wan_state: boolean;
    ip_version: WanIpVersion;
  };
}

interface WanFlowTransition {
  cachedDisconnected: unknown;
  fallbackDisconnected: boolean;
  currentDisconnected: boolean;
  ipVersion: WanIpVersion;
}

export function buildWanFlowEvents({
  cachedDisconnected,
  fallbackDisconnected,
  currentDisconnected,
  ipVersion,
}: WanFlowTransition): WanFlowEvent[] {
  const previousDisconnected = typeof cachedDisconnected === 'boolean'
    ? cachedDisconnected
    : fallbackDisconnected;
  if (previousDisconnected === currentDisconnected) return [];

  const online = !currentDisconnected;
  const tokens = {
    wan_state: online,
    ip_version: ipVersion,
  };
  return [
    {
      cardId: 'alarm_wan_state_changed',
      tokens,
    },
    {
      cardId: online ? 'alarm_wan_state_true' : 'alarm_wan_state_false',
      tokens,
    },
  ];
}
