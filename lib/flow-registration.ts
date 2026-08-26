import type { ClientStatistics } from './advanced-controls';
import type { MeshTrackedClient, TrackedClient } from './client-tracker';
import type { RadioFeature, WirelessNetworkKind } from './deco-features';

type ClientAutocompleteResult = { name: string; mac: string; description: string };

export interface DecoFlowDevice {
  trackedClients: Record<string, TrackedClient>;
  meshTrackedClients: Record<string, MeshTrackedClient>;
  getSettings(): Record<string, unknown>;
  getName(): string;
  getClientStatistics(mac: string): ClientStatistics;
  setClientInternetAccess(mac: string, allowed: boolean): Promise<void>;
  pauseClientInternetAccess(mac: string, durationMinutes: unknown): Promise<void>;
  setWirelessNetworkEnabled(kind: WirelessNetworkKind, enabled: boolean): Promise<void>;
  setRadioFeatureEnabled(feature: RadioFeature, enabled: boolean): Promise<void>;
  runInternetSpeedTest(): Promise<void>;
  refreshNow(): Promise<void>;
}

interface FlowCardLike {
  registerRunListener(listener: (args: any, state: any) => unknown): void;
  registerArgumentAutocompleteListener(
    argument: string,
    listener: (query: string, args: any) => unknown,
  ): void;
}

interface FlowManagerLike {
  getDeviceTriggerCard(id: string): FlowCardLike;
  getTriggerCard(id: string): FlowCardLike;
  getConditionCard(id: string): FlowCardLike;
  getActionCard(id: string): FlowCardLike;
}

interface FlowRegistrationDependencies {
  buildClientAutocomplete(
    device: DecoFlowDevice,
    query: string,
  ): ClientAutocompleteResult[] | Promise<ClientAutocompleteResult[]>;
  buildMeshClientAutocomplete(
    query: string,
  ): ClientAutocompleteResult[] | Promise<ClientAutocompleteResult[]>;
  getMasterDevice(): DecoFlowDevice | undefined;
  getTrackedClients(device: DecoFlowDevice): Record<string, TrackedClient | MeshTrackedClient>;
}

export class DeviceFlowRegistration {
  private registered = false;

  register(flow: FlowManagerLike, dependencies: FlowRegistrationDependencies): boolean {
    if (this.registered) return false;
    this.registered = true;

    this.registerDeviceTriggers(flow, dependencies);
    this.registerClientConditions(flow, dependencies);
    this.registerActions(flow, dependencies);
    this.registerMeshFlows(flow, dependencies);
    return true;
  }

  private registerDeviceTriggers(
    flow: FlowManagerLike,
    dependencies: FlowRegistrationDependencies,
  ): void {
    const clientState = flow.getDeviceTriggerCard('client_state_changed');
    clientState.registerRunListener(async (args, state) => (
      args.status === state.status && args.client.mac === state.client.mac
    ));
    clientState.registerArgumentAutocompleteListener(
      'client',
      async (query, args) => dependencies.buildClientAutocomplete(args.device, query),
    );

    flow.getDeviceTriggerCard('any_client_state_changed').registerRunListener(
      async (args, state) => args.status === state.status,
    );

    const clientNodeChanged = flow.getDeviceTriggerCard('client_node_changed');
    clientNodeChanged.registerRunListener(async (args, state) => args.client.mac === state.mac);
    clientNodeChanged.registerArgumentAutocompleteListener(
      'client',
      async (query, args) => dependencies.buildClientAutocomplete(args.device, query),
    );

    const clientPriorityChanged = flow.getDeviceTriggerCard('client_priority_changed');
    clientPriorityChanged.registerRunListener(async (args, state) => (
      args.client.mac === state.mac
      && args.priority_state === (state.prioritized ? 'prioritized' : 'normal')
    ));
    clientPriorityChanged.registerArgumentAutocompleteListener(
      'client',
      async (query, args) => dependencies.buildClientAutocomplete(args.device, query),
    );
  }

  private registerClientConditions(
    flow: FlowManagerLike,
    dependencies: FlowRegistrationDependencies,
  ): void {
    const clientIsOnline = flow.getConditionCard('client_is_online');
    clientIsOnline.registerRunListener(async (args) => (
      args.device.trackedClients[args.client.mac]?.online === true
    ));
    this.registerClientAutocomplete(clientIsOnline, dependencies);

    const clientIsPrioritized = flow.getConditionCard('client_is_prioritized');
    clientIsPrioritized.registerRunListener(async (args) => (
      dependencies.getTrackedClients(args.device)[args.client.mac]?.prioritized === true
    ));
    this.registerClientAutocomplete(clientIsPrioritized, dependencies);

    const clientSpeedAbove = flow.getConditionCard('client_speed_above');
    clientSpeedAbove.registerRunListener(async (args) => {
      const statistics = args.device.getClientStatistics(args.client.mac);
      const speed = args.direction === 'upload'
        ? statistics.upKiloBytesPerSecond
        : statistics.downKiloBytesPerSecond;
      return speed > Number(args.threshold);
    });
    this.registerClientAutocomplete(clientSpeedAbove, dependencies);
  }

  private registerActions(
    flow: FlowManagerLike,
    dependencies: FlowRegistrationDependencies,
  ): void {
    for (const [cardId, allowed] of [
      ['block_client', false],
      ['unblock_client', true],
    ] as const) {
      const card = flow.getActionCard(cardId);
      card.registerRunListener(async (args) => {
        await args.device.setClientInternetAccess(args.client.mac, allowed);
        return true;
      });
      this.registerClientAutocomplete(card, dependencies);
    }

    flow.getActionCard('set_wireless_network').registerRunListener(async (args) => {
      await args.device.setWirelessNetworkEnabled(args.network, args.state === 'enabled');
      return true;
    });
    flow.getActionCard('refresh_deco').registerRunListener(async (args) => {
      await args.device.refreshNow();
      return true;
    });
    flow.getActionCard('set_radio_feature').registerRunListener(async (args) => {
      await args.device.setRadioFeatureEnabled(args.feature, args.state === 'enabled');
      return true;
    });
    flow.getActionCard('run_speedtest').registerRunListener(async (args) => {
      await args.device.runInternetSpeedTest();
      return true;
    });

    const clientStatistics = flow.getActionCard('get_client_statistics');
    clientStatistics.registerRunListener(async (args) => {
      const statistics = args.device.getClientStatistics(args.client.mac);
      return {
        name: statistics.name,
        mac: statistics.mac,
        ipaddr: statistics.ip,
        online: statistics.online,
        deco_node: statistics.decoNode,
        connection_type: statistics.connectionType,
        network: statistics.network,
        down_speed: statistics.downKiloBytesPerSecond,
        up_speed: statistics.upKiloBytesPerSecond,
        prioritized: statistics.prioritized,
      };
    });
    this.registerClientAutocomplete(clientStatistics, dependencies);

    const pauseClient = flow.getActionCard('pause_client');
    pauseClient.registerRunListener(async (args) => {
      await args.device.pauseClientInternetAccess(args.client.mac, args.duration);
      return true;
    });
    this.registerClientAutocomplete(pauseClient, dependencies);
  }

  private registerMeshFlows(
    flow: FlowManagerLike,
    dependencies: FlowRegistrationDependencies,
  ): void {
    for (const cardId of ['client_joined_mesh', 'client_left_mesh']) {
      const card = flow.getTriggerCard(cardId);
      card.registerRunListener(async (args, state) => args.client.mac === state.mac);
      card.registerArgumentAutocompleteListener(
        'client',
        async (query) => dependencies.buildMeshClientAutocomplete(query),
      );
    }

    const clientPresent = flow.getConditionCard('client_present_in_mesh');
    clientPresent.registerRunListener(async (args) => (
      dependencies.getMasterDevice()?.meshTrackedClients[args.client.mac]?.online === true
    ));
    clientPresent.registerArgumentAutocompleteListener(
      'client',
      async (query) => dependencies.buildMeshClientAutocomplete(query),
    );
  }

  private registerClientAutocomplete(
    card: FlowCardLike,
    dependencies: FlowRegistrationDependencies,
  ): void {
    card.registerArgumentAutocompleteListener(
      'client',
      async (query, args) => dependencies.buildClientAutocomplete(args.device, query),
    );
  }
}
