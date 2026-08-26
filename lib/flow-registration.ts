type ClientAutocompleteBuilder = (
  device: unknown,
  query: string,
) => unknown[] | Promise<unknown[]>;

interface FlowManagerLike {
  getDeviceTriggerCard(id: string): any;
}

export class DeviceFlowRegistration {
  private registered = false;

  register(
    flow: FlowManagerLike,
    buildClientAutocomplete: ClientAutocompleteBuilder,
  ): boolean {
    if (this.registered) return false;
    this.registered = true;

    const clientState = flow.getDeviceTriggerCard('client_state_changed');
    clientState.registerRunListener(async (args: any, state: any) => (
      args.status === state.status && args.client.mac === state.client.mac
    ));
    clientState.registerArgumentAutocompleteListener(
      'client',
      async (query: string, args: any) => buildClientAutocomplete(args.device, query),
    );

    const anyClientState = flow.getDeviceTriggerCard('any_client_state_changed');
    anyClientState.registerRunListener(async (args: any, state: any) => (
      args.status === state.status
    ));

    const clientNodeChanged = flow.getDeviceTriggerCard('client_node_changed');
    clientNodeChanged.registerRunListener(async (args: any, state: any) => (
      args.client.mac === state.mac
    ));
    clientNodeChanged.registerArgumentAutocompleteListener(
      'client',
      async (query: string, args: any) => buildClientAutocomplete(args.device, query),
    );

    return true;
  }
}
