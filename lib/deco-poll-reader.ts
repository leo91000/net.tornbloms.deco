import {
  ClientListResponse,
  DecoClient,
  DeviceListResponse,
  InternetResponse,
  PerformanceResponse,
  WANResponse,
} from './client';
import { tryApiCall } from './polling';

type DecoNode = DeviceListResponse['result']['device_list'][number];

export interface DecoPollApi {
  custom<T>(
    endpoint: string,
    params: { form: string },
    body: Buffer,
  ): Promise<T>;
}

export interface DecoPollLogger {
  error(message: string, error: unknown): void;
}

export type DecoPollResult =
  | { status: 'authentication-required' }
  | { status: 'device-missing'; nodes: DecoNode[] }
  | {
      status: 'ok';
      nodes: DecoNode[];
      node: DecoNode;
      isMaster: boolean;
      performance?: PerformanceResponse;
      wan?: WANResponse;
      internet?: InternetResponse;
      clientsAvailable: boolean;
      clients: DecoClient[];
    };

/**
 * Reads one coherent Deco polling snapshot.
 *
 * The Homey device owns presentation and flow side effects; this module owns
 * which router endpoints are called, in which order, and how firmware response
 * quirks are normalised.
 */
export class DecoPollReader {
  private readonly readBody = Buffer.from('{"operation":"read"}');

  constructor(
    private readonly api: DecoPollApi,
    private readonly logger: DecoPollLogger,
  ) {}

  async read(deviceMac: string, includePerformance: boolean): Promise<DecoPollResult> {
    const deviceList = await this.call<DeviceListResponse>(
      '/admin/device',
      'device_list',
      this.readBody,
      'Failed to retrieve Device Data',
    );
    const nodes = deviceList?.result?.device_list;
    if (deviceList?.error_code !== 0 || !Array.isArray(nodes)) {
      return { status: 'authentication-required' };
    }

    const node = nodes.find((candidate) => candidate.mac === deviceMac);
    if (!node) return { status: 'device-missing', nodes };

    const isMaster = node.role.toLowerCase() === 'master';
    const performance = isMaster && includePerformance
      ? await this.call<PerformanceResponse>(
        '/admin/network',
        'performance',
        this.readBody,
        'Failed to retrieve Performance Metrics',
      )
      : undefined;
    const wan = isMaster
      ? await this.call<WANResponse>(
        '/admin/network',
        'wan_ipv4',
        this.readBody,
        'Failed to retrieve WAN IPv4 Data',
      )
      : undefined;
    const internet = isMaster
      ? await this.call<InternetResponse>(
        '/admin/network',
        'internet',
        this.readBody,
        'Failed to retrieve Internet Status',
      )
      : undefined;

    const clientBody = Buffer.from(JSON.stringify({
      operation: 'read',
      params: { device_mac: deviceMac },
    }));
    const clientResponse = await this.call<ClientListResponse>(
      '/admin/client',
      'client_list',
      clientBody,
      'Failed to retrieve Client List',
    );
    const clientsAvailable = clientResponse?.error_code === 0;
    const rawClients = clientResponse?.result?.client_list;
    const clients = clientsAvailable && Array.isArray(rawClients)
      ? rawClients.map((client) => this.normaliseAccessHost(client, nodes, deviceMac))
      : [];

    return {
      status: 'ok',
      nodes,
      node,
      isMaster,
      performance: performance ?? undefined,
      wan: wan ?? undefined,
      internet: internet ?? undefined,
      clientsAvailable,
      clients,
    };
  }

  private async call<T>(
    endpoint: string,
    form: string,
    body: Buffer,
    errorMessage: string,
  ): Promise<T | null> {
    return tryApiCall<T>(
      () => this.api.custom<T>(endpoint, { form }, body),
      (error) => this.logger.error(errorMessage, error),
    );
  }

  private normaliseAccessHost(
    client: DecoClient,
    nodes: DecoNode[],
    requestedDeviceMac: string,
  ): DecoClient {
    const accessHost = client.access_host ?? '';
    const isKnownNode = nodes.some((node) => (
      node.mac === accessHost || node.device_id === accessHost
    ));
    if (isKnownNode) return client;

    // Some firmware returns the local placeholder "1". The request is scoped
    // to one node, so that node is the reliable source in this case.
    return { ...client, access_host: requestedDeviceMac };
  }
}
