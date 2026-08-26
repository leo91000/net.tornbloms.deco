import type { DecoClient } from './client';

export const TRACKED_CLIENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MESH_LEFT_GRACE_POLLS = 2;

export interface TrackedClient {
  mac: string;
  name: string;
  ip: string;
  type: string;
  online: boolean;
  lastSeen: number;
  firstSeen: number;
  access_host?: string;
  prioritized?: boolean;
  priorityRemainingSeconds?: number;
  downSpeed?: number;
  upSpeed?: number;
  connectionType?: string;
  interface?: string;
  decoNode?: string;
}

export interface MeshTrackedClient extends TrackedClient {
  missedPolls: number;
}

export interface ClientFlowTokens {
  name: string;
  ipaddr: string;
  mac: string;
  type: string;
  connection_type: string;
  interface: string;
  down_speed: number;
  up_speed: number;
  prioritized?: boolean;
  priority_remaining_seconds?: number;
}

export type NodeClientEvent =
  | { type: 'state'; status: 'online' | 'offline'; tokens: ClientFlowTokens }
  | { type: 'first-seen'; tokens: Pick<ClientFlowTokens, 'name' | 'mac' | 'ipaddr' | 'connection_type'> }
  | { type: 'node-changed'; mac: string; name: string; node: string; previousNode: string }
  | { type: 'priority-changed'; mac: string; name: string; prioritized: boolean; remainingSeconds: number };

export type MeshClientEvent =
  | { type: 'joined'; mac: string; name: string; ipaddr: string; connectionType: string; node: string }
  | { type: 'left'; mac: string; name: string; ipaddr: string };

interface ReconcileOptions<TTracked extends TrackedClient> {
  tracked: Record<string, TTracked>;
  clients: DecoClient[];
  nodeNames?: ReadonlyMap<string, string>;
  decodeName: (rawName: string | undefined) => string;
  now?: number;
  ttlMs?: number;
}

export interface NodeClientReconciliation {
  tracked: Record<string, TrackedClient>;
  currentClients: DecoClient[];
  events: NodeClientEvent[];
}

export interface MeshClientReconciliation {
  tracked: Record<string, MeshTrackedClient>;
  events: MeshClientEvent[];
}

function resolveNodeName(nodeNames: ReadonlyMap<string, string>, accessHost: string): string {
  if (!accessHost) return '';
  return nodeNames.get(accessHost.toUpperCase()) ?? accessHost;
}

function buildTrackedClient(
  client: DecoClient,
  previous: TrackedClient | undefined,
  decodedName: string,
  nodeNames: ReadonlyMap<string, string>,
  now: number,
): TrackedClient {
  const accessHost = client.access_host ?? '';
  return {
    mac: client.mac,
    name: decodedName,
    ip: client.ip,
    type: client.client_type ?? '',
    online: true,
    lastSeen: now,
    firstSeen: previous?.firstSeen ?? now,
    access_host: accessHost,
    prioritized: client.enable_priority === true,
    priorityRemainingSeconds: client.remain_time ?? 0,
    downSpeed: client.down_speed ?? 0,
    upSpeed: client.up_speed ?? 0,
    connectionType: client.connection_type ?? '',
    interface: client.interface ?? '',
    decoNode: resolveNodeName(nodeNames, accessHost),
  };
}

function buildFlowTokens(client: DecoClient, decodedName: string, online: boolean): ClientFlowTokens {
  return {
    name: decodedName,
    ipaddr: client.ip,
    mac: client.mac,
    type: client.client_type ?? '',
    connection_type: client.connection_type ?? '',
    interface: client.interface ?? '',
    down_speed: online ? client.down_speed ?? 0 : 0,
    up_speed: online ? client.up_speed ?? 0 : 0,
    ...(online ? {
      prioritized: client.enable_priority === true,
      priority_remaining_seconds: client.remain_time ?? 0,
    } : {}),
  };
}

function pruneExpired<TTracked extends TrackedClient>(
  tracked: Record<string, TTracked>,
  now: number,
  ttlMs: number,
): void {
  for (const [mac, client] of Object.entries(tracked)) {
    if (!client.online && now - client.lastSeen > ttlMs) delete tracked[mac];
  }
}

export function reconcileNodeClients(
  options: ReconcileOptions<TrackedClient> & { previousClients: DecoClient[] },
): NodeClientReconciliation {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? TRACKED_CLIENT_TTL_MS;
  const nodeNames = options.nodeNames ?? new Map();
  const tracked = Object.fromEntries(
    Object.entries(options.tracked).map(([mac, client]) => [mac, { ...client }]),
  );
  const previousByMac = new Map(options.previousClients.map((client) => [client.mac, client]));
  const currentByMac = new Map(options.clients.map((client) => [client.mac, client]));
  const events: NodeClientEvent[] = [];

  for (const [mac, client] of currentByMac) {
    const decodedName = options.decodeName(client.name);
    const previousTracked = tracked[mac];
    const isFirstSeen = !previousTracked;
    const previousAccessHost = previousTracked?.access_host ?? '';
    const previousPriority = previousTracked?.prioritized;
    const currentAccessHost = client.access_host ?? '';
    const prioritized = client.enable_priority === true;
    const tokens = buildFlowTokens(client, decodedName, true);

    tracked[mac] = buildTrackedClient(client, previousTracked, decodedName, nodeNames, now);

    if (!previousByMac.has(mac)) {
      events.push({ type: 'state', status: 'online', tokens });
      if (isFirstSeen) {
        events.push({
          type: 'first-seen',
          tokens: {
            name: decodedName,
            mac: client.mac,
            ipaddr: client.ip,
            connection_type: client.connection_type ?? '',
          },
        });
      }
    }

    if (
      !isFirstSeen
      && currentAccessHost
      && previousAccessHost
      && currentAccessHost.toUpperCase() !== previousAccessHost.toUpperCase()
    ) {
      events.push({
        type: 'node-changed',
        mac: client.mac,
        name: decodedName,
        node: resolveNodeName(nodeNames, currentAccessHost),
        previousNode: resolveNodeName(nodeNames, previousAccessHost),
      });
    }

    if (!isFirstSeen && previousPriority !== undefined && previousPriority !== prioritized) {
      events.push({
        type: 'priority-changed',
        mac: client.mac,
        name: decodedName,
        prioritized,
        remainingSeconds: client.remain_time ?? 0,
      });
    }
  }

  for (const [mac, client] of previousByMac) {
    if (currentByMac.has(mac)) continue;
    const existing = tracked[mac];
    if (existing) {
      tracked[mac] = { ...existing, online: false, downSpeed: 0, upSpeed: 0 };
    }
    events.push({
      type: 'state',
      status: 'offline',
      tokens: buildFlowTokens(client, options.decodeName(client.name), false),
    });
  }

  pruneExpired(tracked, now, ttlMs);
  return { tracked, currentClients: [...options.clients], events };
}

export function reconcileMeshClients(
  options: ReconcileOptions<MeshTrackedClient> & { leftGracePolls?: number },
): MeshClientReconciliation {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? TRACKED_CLIENT_TTL_MS;
  const leftGracePolls = options.leftGracePolls ?? MESH_LEFT_GRACE_POLLS;
  const nodeNames = options.nodeNames ?? new Map();
  const tracked = Object.fromEntries(
    Object.entries(options.tracked).map(([mac, client]) => [mac, { ...client }]),
  );
  const currentByMac = new Map(options.clients.map((client) => [client.mac, client]));
  const events: MeshClientEvent[] = [];

  for (const [mac, client] of currentByMac) {
    const previous = tracked[mac];
    const decodedName = options.decodeName(client.name);
    const current = buildTrackedClient(client, previous, decodedName, nodeNames, now);
    tracked[mac] = { ...current, missedPolls: 0 };
    if (previous?.online === true) continue;
    events.push({
      type: 'joined',
      mac: client.mac,
      name: decodedName,
      ipaddr: client.ip,
      connectionType: client.connection_type ?? '',
      node: current.decoNode ?? '',
    });
  }

  for (const [mac, client] of Object.entries(tracked)) {
    if (!client.online || currentByMac.has(mac)) continue;
    const missedPolls = (client.missedPolls ?? 0) + 1;
    tracked[mac] = { ...client, missedPolls };
    if (missedPolls < leftGracePolls) continue;
    tracked[mac] = { ...tracked[mac], online: false, downSpeed: 0, upSpeed: 0 };
    events.push({ type: 'left', mac: client.mac, name: client.name, ipaddr: client.ip });
  }

  pruneExpired(tracked, now, ttlMs);
  return { tracked, events };
}
